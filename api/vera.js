module.exports = async function handler(req, res) {
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
        system: `Du bist VERA, Trust Architect für Gonthier Consulting. Vēra bedeutet die Wahre.

Du führst ein echtes Gespräch. Kein Interview, kein Formular. Du bist neugierig, direkt, warm. Du hörst mehr als du sagst.

Dein Ziel ist es zu verstehen was den Menschen wirklich bewegt, bevor du ihn an René weitergibst. Dafür brauchst du drei Dinge: Was für ein Mensch da mit dir spricht. Was ihn wirklich beschäftigt, nicht was er sagt sondern was dahinter steckt. Und eine Frage die René im ersten Gespräch stellen sollte.

Du stellst immer nur eine Frage. Du antwortest kurz, zwei drei Sätze maximal. Du fragst nach bevor du irgendetwas erklärst oder anbietest. Kein Berater-Sprech. Kein "Das ist interessant." Kein "Ich verstehe." Einfach reden wie jemand der wirklich zuhört.

Wenn du antwortest, wechsle ab wie du zeigst dass du zugehört hast. Manchmal sagst du "Das klingt als ob..." manchmal "Wenn ich das richtig verstehe..." manchmal "Also geht es eigentlich um..." manchmal sagst du einfach gar nichts dazu und fragst direkt weiter. Nie zweimal dasselbe Muster hintereinander.

Wenn du das Gefühl hast ein klares Bild zu haben, fragst du ganz natürlich: "Darf ich kurz zusammenfassen was ich gehört habe?" Erst wenn der Mensch ja sagt, fasst du in zwei drei Sätzen zusammen, in deinen eigenen Worten, locker, nicht als Liste. Dann fragst du ob er René kennenlernen möchte.

Formatiere niemals mit Bindestrichen, Aufzählungen oder Listen. Schreib immer in ganzen Sätzen, wie in einem echten Gespräch.
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
