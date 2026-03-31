export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, filename, accountType } = req.body;
  if (!text || text.trim().length < 50)
    return res.status(400).json({ error: 'Text too short or empty' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const accountTypeLabel = {
    credit: 'credit card',
    debit: 'debit card',
    savings: 'savings account',
    checking: 'checking account',
  }[accountType] || 'bank account';

  const prompt = `You are a bank statement parser. Your ONLY job is to extract transactions as structured data. Do NOT categorize anything.

This is a ${accountTypeLabel} statement.

Extract every transaction from this statement. Output valid JSON only — no markdown, no explanation.

Field definitions:
- date: transaction date in YYYY-MM-DD format
- description: the merchant name, counterparty, or transaction label as it appears. Remove raw account numbers and hashes but keep all meaningful text.
- amount: always a positive number. Direction handles the sign.
- direction: "credit" = money IN, "debit" = money OUT
- type: the transaction mechanism as written in the statement — e.g. "Compra", "Transferencia", "Purchase", "Direct Debit", "Wire Transfer", "ATM Withdrawal". Keep original language.
- reference: any short human-written note describing the payment purpose. Different banks call this: Concepto, Glosa, Memo, Narration, Payment Reference, Details, Remarks. null if not present.
- merchantHint: if a separate column exists for merchant name or location (e.g. Lugar, Establecimiento, Merchant, Payee) that differs from description, extract it here. null otherwise.
- counterpartyName: name of the person or business on the other side of the transaction if visible. null if not present.
- counterpartyAccount: account number, IBAN, CLABE, or routing ID of the counterparty if visible. null if not present.

Rules:
1. Amounts always positive — use direction for credit/debit
2. For Excel/CSV: map columns to fields by meaning regardless of language
3. Include ALL rows — fees, interest, taxes, corrections, reversals
4. For installment plan summaries, include each as a transaction with type "Installment Plan"
5. Never skip rows — include uncertain ones with best effort
6. Works for any language — extract fields using the same logic regardless

Statement:
${text.slice(0, 100000)}`;

  async function callWithRetry(payload, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (data.error?.type === 'overloaded_error') {
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
          continue;
        }
        return res.status(503).json({ error: 'Anthropic API is temporarily overloaded — please try again in a few seconds' });
      }
      return data;
    }
  }

  try {
    const data = await callWithRetry({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    if (data.error) return res.status(502).json({ error: data.error.message });

    const raw = data.content?.[0]?.text || '';
    let jsonStr = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const firstMatch = jsonStr.match(/[{\[]/);
    if (firstMatch) {
      const startIdx = jsonStr.indexOf(firstMatch[0]);
      if (startIdx > 0) jsonStr = jsonStr.slice(startIdx);
      const endChar = firstMatch[0] === '{' ? '}' : ']';
      const lastIdx = jsonStr.lastIndexOf(endChar);
      if (lastIdx !== -1 && lastIdx < jsonStr.length - 1) jsonStr = jsonStr.slice(0, lastIdx + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error('Parse JSON error. Raw:', raw.slice(0, 1000));
      return res.status(500).json({
        error: 'Could not parse AI response as JSON',
        raw: raw.slice(0, 500),
        hint: 'Check Vercel function logs for full response'
      });
    }

    // Normalize: if AI returned bare array, wrap it
    if (Array.isArray(parsed)) {
      parsed = { transactions: parsed };
    }
    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
