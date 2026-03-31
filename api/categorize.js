export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transactions, country, accountType, categories } = req.body;
  if (!transactions || !Array.isArray(transactions) || transactions.length === 0)
    return res.status(400).json({ error: 'transactions array required' });
  if (!categories || !Array.isArray(categories) || categories.length === 0)
    return res.status(400).json({ error: 'categories array required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const CONFIDENCE_THRESHOLD = 0.70;
  const CHUNK_SIZE = 50;

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
        return { error: { message: 'Anthropic API is temporarily overloaded — please try again in a few seconds', type: 'overloaded_error' } };
      }
      return data;
    }
  }

  function buildPrompt(chunk, chunkIndex, categories, country, accountType) {
    const categoryList = categories.map(c => {
      const examples = c.examples ? ` Examples: ${c.examples}.` : '';
      return `- ${c.id}: ${c.label} — ${c.description}.${examples}`;
    }).join('\n');

    const formatted = chunk.map((t, i) => {
      const parts = [`${chunkIndex + i + 1}. description: "${t.description}"`];
      if (t.type)             parts.push(`type: "${t.type}"`);
      if (t.reference)        parts.push(`reference: "${t.reference}"`);
      if (t.merchantHint)     parts.push(`merchant: "${t.merchantHint}"`);
      if (t.counterpartyName) parts.push(`counterparty: "${t.counterpartyName}"`);
      parts.push(`amount: ${t.amount}`);
      parts.push(`direction: ${t.direction}`);
      return parts.join(', ');
    }).join('\n');

    return `You are a personal finance transaction categorizer working with bank statements from any country worldwide.

Context: transactions from ${country || 'unknown country'}, account type: ${accountType || 'unknown'}.

The user has defined the following categories. Use ONLY these exact category IDs — do not invent new ones:
${categoryList}

Two special categories always available:
- internal_transfer: movement between the user's own accounts, credit card bill payments
- unassigned: use this when you genuinely cannot determine the category even with all context

Categorization strategy:
1. Use ALL available fields together — description + type + reference + merchantHint + counterpartyName + amount + direction
2. Transaction mechanism (the "type" field) is highly informative:
   - Debit card purchase → categorize by what the merchant sells
   - Bank transfer with a purpose note → use the note/reference to determine category
   - Transfer to/from an individual with no clear purpose → reimbursement or unassigned
   - Automatic/system entry → likely income (interest) or internal_transfer (fee)
3. The reference/memo/note field beats the description when they conflict — it is the human-written intent
4. merchantHint contains the actual merchant name when available — prioritize it
5. If the merchant is unfamiliar, use all other context clues before defaulting to unassigned
6. Confidence scoring:
   - 0.9+: clear well-known merchant, or explicit purpose in reference field
   - 0.7-0.9: strong contextual clues, reasonable inference
   - 0.5-0.7: some signal but meaningful uncertainty
   - below 0.5 → set category to "unassigned" regardless of best guess

Transactions:
${formatted}

Return a JSON array, one object per transaction in the same order:
[{"index": 1, "category": "groceries", "confidence": 0.95, "reasoning": "max 10 words"}]

Return ONLY the JSON array.`;
  }

  try {
    // Split into chunks of CHUNK_SIZE
    const chunks = [];
    for (let i = 0; i < transactions.length; i += CHUNK_SIZE) {
      chunks.push({ txns: transactions.slice(i, i + CHUNK_SIZE), startIndex: i });
    }

    const allResults = [];

    for (const { txns, startIndex } of chunks) {
      const prompt = buildPrompt(txns, startIndex, categories, country, accountType);

      const data = await callWithRetry({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      });

      if (data.error) return res.status(502).json({ error: data.error.message });

      const raw = data.content?.[0]?.text || '[]';
      let jsonStr = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const firstBracket = jsonStr.indexOf('[');
      if (firstBracket > 0) jsonStr = jsonStr.slice(firstBracket);
      const lastBracket = jsonStr.lastIndexOf(']');
      if (lastBracket !== -1) jsonStr = jsonStr.slice(0, lastBracket + 1);

      let chunkResults;
      try {
        chunkResults = JSON.parse(jsonStr);
      } catch (e) {
        return res.status(500).json({ error: 'Could not parse categorization response', raw: raw.slice(0, 300) });
      }

      // Apply confidence threshold
      chunkResults = chunkResults.map(r => ({
        ...r,
        finalCategory: r.confidence >= CONFIDENCE_THRESHOLD ? r.category : 'unassigned',
        autoUnassigned: r.confidence < CONFIDENCE_THRESHOLD && r.category !== 'unassigned',
      }));

      allResults.push(...chunkResults);
    }

    return res.status(200).json({ results: allResults });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
