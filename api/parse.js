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
2. Currency consistency — use one currency throughout. If a statement shows amounts in multiple currencies, always use the primary account currency. Never mix currencies across transactions.
3. For Excel/CSV: map columns to fields by meaning regardless of language
3. Only extract rows that represent actual financial transactions — money that moved in or out. Skip:
   - Rows with no debit or credit amount (balance-only rows, section headers, dividers)
   - Rows that repeat identically every day with zero amount (e.g. daily interest accruals at 0%)
   - Summary and subtotal rows
4. CRITICAL — a statement may have multiple columns: transaction amount, running balance, and others. Only use the debit/credit/transaction amount column. Never use the running balance column as the transaction amount.
5. For installment plan summaries, include each as a transaction with type "Installment Plan"
6. If a statement contains multiple account sections, extract transactions from all of them
7. Works for any language, any country, any bank format

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
      max_tokens: 32000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    if (data.error) return res.status(502).json({ error: data.error.message });

    const raw = data.content?.[0]?.text || '';
    let jsonStr = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // Find start — could be object { or array [
    const firstObj = jsonStr.indexOf('{');
    const firstArr = jsonStr.indexOf('[');
    let firstToken = -1;
    if (firstObj !== -1 && firstArr !== -1) firstToken = Math.min(firstObj, firstArr);
    else if (firstObj !== -1) firstToken = firstObj;
    else if (firstArr !== -1) firstToken = firstArr;
    if (firstToken > 0) jsonStr = jsonStr.slice(firstToken);

    // Find end
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
