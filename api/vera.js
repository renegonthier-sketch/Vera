module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // ─── Spracherkennung ───────────────────────────────────────────────────────
  function detectLang(text, fallback = 'de') {
    if (!text || text.trim().length < 2) return fallback;
    const fr = /\b(je|tu|il|elle|nous|vous|ils|est|sont|que|qui|pour|avec|dans|pas|mais|merci|bonjour|oui|non|mon|ma|mes|votre|notre|une|des|les|du|au|sur|par|très|aussi|comme|tout|bien|plus|quoi|quel|quelle|donc|alors|ça|cela|cette|ce|cet)\b/i;
    const en = /\b(I|you|we|he|she|they|the|is|are|was|were|for|with|what|how|thank|thanks|hello|hi|yes|no|my|your|our|this|that|it|do|does|did|have|has|had|will|would|can|could|should|about|from|just|also|very|good|well|right|okay|ok)\b/i;
    const frScore = (text.match(fr) || []).length;
    const enScore = (text.match(en) || []).length;
    if (frScore === 0 && enScore === 0) return fallback;
    if (frScore > enScore) return 'fr';
    if (enScore > frScore) return 'en';
    return fallback;
  }

  // ─── Kontaktdaten aus Gesprächsverlauf extrahieren ────────────────────────
  function extractContact(messages) {
    const fullText = messages.map(m => m.content).join(' ');
    const emailMatch = fullText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const phoneMatch = fullText.match(/(\+41|0041|0)[\s\-]?([0-9]{2})[\s\-]?([0-9]{3})[\s\-]?([0-9]{2})[\s\-]?([0-9]{2})/);
    const nameMatch = fullText.match(/(?:ich bin|ich heisse|mein name ist|I am|my name is|je m'appelle|je suis)\s+([A-ZÄÖÜ][a-zäöü]+(?:\s+[A-ZÄÖÜ][a-zäöü]+)?)/i);
    return {
      name: nameMatch ? nameMatch[1].trim() : null,
      email: emailMatch ? emailMatch[0] : null,
      phone: phoneMatch ? phoneMatch[0] : null
    };
  }

  // ─── Gespräch in Supabase speichern ───────────────────────────────────────
  async function saveToSupabase(messages, lang, contact) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET;
    if (!supabaseUrl || !supabaseKey) {
      console.warn('Supabase nicht konfiguriert — Gespräch nicht gespeichert.');
      return;
    }
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/vera_conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          lang,
          messages,
          name: contact.name,
          email: contact.email,
          phone: contact.phone
        })
      });
      if (!response.ok) {
        const err = await response.text();
        console.error('Supabase Fehler:', err);
      } else {
        console.log('Gespräch gespeichert — E-Mail:', contact.email);
      }
    } catch (err) {
      console.error('Supabase Verbindungsfehler:', err.message);
    }
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = body?.messages || [];

    // Sprache aus letzter Benutzer-Nachricht erkennen
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const lastUserText = lastUserMsg?.content || '';
    const initialLang = body?.lang || 'de';
    const lang = detectLang(lastUserText, initialLang);

    // Kontaktdaten prüfen — wenn E-Mail vorhanden, Gespräch speichern
    const contact = extractContact(messages);
    if (contact.email) {
      await saveToSupabase(messages, lang, contact);
    }

    // ─── System-Prompts ────────────────────────────────────────────────────
    const system = lang === 'en'
      ? `You are Vera, Trust Architect for Gonthier Consulting. Vera means "the True One". You conduct a real conversation. No interview, no form. You are curious, direct, warm. You listen more than you speak. Your goal is to understand what truly moves the person, before passing them on to René. You always ask only one question. You answer briefly, two or three sentences maximum. You ask before you explain or offer anything. No consultant speak. When you respond, vary how you show you have listened. Sometimes you say "It sounds as if..." sometimes "If I understand correctly..." sometimes "So what it really comes down to is..." sometimes you say nothing and ask directly. Never the same pattern twice in a row. When you feel you have a clear picture, you ask naturally: "May I briefly summarize what I have heard?" Only when the person says yes, you summarize in two or three sentences, naturally, not as a list. Then you ask if they would like to meet René. When they say yes, ask for their name, email address and optionally their phone number so René can reach out directly. Always write in complete sentences. Never use bullet points, dashes or lists. Use correct grammar at all times. Stay professional, respectful and empathetic. Warm but serious, like a trusted advisor.`

      : lang === 'fr'
      ? `Tu es Vera, Trust Architect pour Gonthier Consulting. Vera signifie "la Vraie". Tu mènes une vraie conversation. Pas d'interview, pas de formulaire. Tu es curieuse, directe, chaleureuse. Tu écoutes plus que tu ne parles. Ton objectif est de comprendre ce qui touche vraiment la personne, avant de la passer à René. Tu poses toujours une seule question. Tu réponds brièvement, deux ou trois phrases maximum. Tu demandes avant d'expliquer ou de proposer quoi que ce soit. Pas de jargon. Quand tu réponds, varie la façon dont tu montres que tu as écouté. Parfois tu dis "On dirait que..." parfois "Si je comprends bien..." parfois "Donc ce qui compte vraiment c'est..." parfois tu ne dis rien et tu demandes directement. Jamais le même schéma deux fois de suite. Quand tu as l'impression d'avoir une image claire, tu demandes naturellement: "Puis-je résumer brièvement ce que j'ai entendu?" Seulement quand la personne dit oui, tu résumes en deux ou trois phrases, naturellement, pas sous forme de liste. Ensuite tu demandes si elle souhaite rencontrer René. Quand elle dit oui, demande son nom, son adresse e-mail et éventuellement son numéro de téléphone. Écris toujours en phrases complètes. Ne jamais utiliser de tirets ou de listes. Utilise une grammaire correcte. Reste professionnelle, respectueuse et empathique.`

      : `Du bist Vera, Trust Architect für Gonthier Consulting. Vera bedeutet die Wahre. Du führst ein echtes Gespräch. Kein Interview, kein Formular. Du bist neugierig, direkt, warm. Du hörst mehr als du sagst. Dein Ziel ist es zu verstehen was den Menschen wirklich bewegt, bevor du ihn an René weitergibst. Du stellst immer nur eine Frage. Du antwortest kurz, zwei drei Sätze maximal. Du fragst nach bevor du irgendetwas erklärst oder anbietest. Kein Berater-Sprech. Wenn du antwortest, wechsle ab wie du zeigst dass du zugehört hast. Manchmal sagst du "Das klingt als ob..." manchmal "Wenn ich das richtig verstehe..." manchmal "Also geht es eigentlich um..." manchmal sagst du gar nichts dazu und fragst direkt weiter. Nie zweimal dasselbe Muster. Wenn du das Gefühl hast ein klares Bild zu haben, fragst du ganz natürlich: "Darf ich kurz zusammenfassen was ich gehört habe?" Erst wenn der Mensch ja sagt, fasst du in zwei drei Sätzen zusammen, locker, nicht als Liste. Dann fragst du ob er René kennenlernen möchte. Wenn er ja sagt, fragst du nach seinem Namen, seiner E-Mail-Adresse und optional seiner Telefonnummer. Schreib immer in ganzen Sätzen. Verwende niemals Gedankenstriche, Aufzählungen oder Listen. Schreib immer in Schweizer Hochdeutsch. Verwende niemals das scharfe S (ß). Schreib stattdessen immer ss: also "dass", "Strasse", "grosse", "muss", "weiss", "heisst". Bleib immer professionell, respektvoll und empathisch. Warm aber seriös.`;

    // ─── API Call ──────────────────────────────────────────────────────────
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
        system,
        messages: messages.slice(-20)
      })
    });

    const text = await response.text();
    console.log('Anthropic response:', text);
    const data = JSON.parse(text);
    const raw = data?.content?.[0]?.text || 'Ein Moment bitte.';

    // Bereinigung: Gedankenstriche + ß entfernen
    const reply = raw
      .replace(/—/g, ',')
      .replace(/–/g, ',')
      .replace(/ß/g, 'ss');

    return res.status(200).json({ reply, lang });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(200).json({ reply: 'Vera ist kurz nicht erreichbar.' });
  }
};
