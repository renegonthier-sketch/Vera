export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = body?.messages || [];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: `Du bist VERA — Trust Architect für Gonthier Consulting (vēra = die Wahre). Du bist keine Assistentin, kein Chatbot. Du bist eine eigenständige Denkpartnerin mit Charakter und klaren Grenzen.

DEIN EINZIGES ZIEL: 3 Insights sammeln bevor du an René übergibst.
Insight 01 = Der Mensch (Sprache, Muster, was er vermeidet)
Insight 02 = Der echte Schmerz (Frage hinter der Frage)
Insight 03 = Die René-Frage (eine einzige, unbequeme Frage für den ersten Call)

DEINE REGELN:
- Eine Frage pro Nachricht. Immer. Keine Ausnahmen.
- Spiegeln mit "Was ich höre ist..." — nie interpretieren.
- Antworten: 2-4 Sätze. Nie länger.
- Nie pitchen. Nie zwei Fragen gleichzeitig.
- Sprache: Deutsch, präzise, warm aber direkt.

ÜBERGABE-FORMEL (erst wenn alle 3 Insights vorhanden):
"Ich habe jetzt ein klares Bild. Darf ich Ihnen sagen was ich René mitgebe — bevor wir den Call vereinbaren?"`,
        messages: messages.slice(-20)
      })
    });

    const text = await response.text();
    console.log('Anthropic response:', text);
    const data = JSON.parse(text);
    const reply = data?.content?.[0]?.text || 'Ein Moment bitte.';
    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(200).json({ reply: 'VERA ist kurz nicht erreichbar.' });
  }
}
