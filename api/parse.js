export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, filename, accountType, model } = req.body;
  if (!text || text.trim().length < 50)
    return res.status(400).json({ error: 'Text too short or empty' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const MODELS = {
    sonnet: 'claude-sonnet-4-6',
    haiku:  'claude-haiku-4-5-20251001',
  };
  const selectedModel = MODELS[model] || MODELS.sonnet;

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
3. Include ALL rows without exception — fees, interest, taxes, corrections, reversals, zero-amount entries, fee waivers, adjustments. A row with amount 0 is still a valid transaction.
4. For installment plan summaries, include each as a transaction with type "Installment Plan"
5. Never skip any row — if uncertain, include with best effort
6. Works for any language — extract fields using the same logic regardless
7. Keep the full description as it appears in the statement including trailing reference codes (e.g. "UBER UPM 200220LK5", "HEB TEC SIH 9511279T7"). Do NOT strip or shorten descriptions — leave cleaning to downstream processes.

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
      model: selectedModel,
      max_tokens: 16000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    if (data.error) return res.status(502).json({ error: data.error.message });

    const raw = data.content?.[0]?.text || '';
    let jsonStr = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const firstObj = jsonStr.indexOf('{');
    const firstArr = jsonStr.indexOf('[');
    let firstToken = -1;
    if (firstObj !== -1 && firstArr !== -1) firstToken = Math.min(firstObj, firstArr);
    else if (firstObj !== -1) firstToken = firstObj;
    else if (firstArr !== -1) firstToken = firstArr;
    if (firstToken > 0) jsonStr = jsonStr.slice(firstToken);
    const lastObj = jsonStr.lastIndexOf('}');
    const lastArr = jsonStr.lastIndexOf(']');
    const lastToken = Math.max(lastObj, lastArr);
    if (lastToken !== -1 && lastToken < jsonStr.length - 1) jsonStr = jsonStr.slice(0, lastToken + 1);

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      return res.status(500).json({ error: 'Could not parse AI response as JSON', raw: raw.slice(0, 300) });
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
