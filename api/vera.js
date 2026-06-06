module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

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

  async function saveToSupabase(messages, lang, contact) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET;
    if (!supabaseUrl || !supabaseKey) return;
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/vera_conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ lang, messages, name: contact.name, email: contact.email, phone: contact.phone })
      });
      if (!response.ok) console.error('Supabase Fehler:', await response.text());
      else console.log('Supabase: Gespräch gespeichert —', contact.email);
    } catch (err) {
      console.error('Supabase Verbindungsfehler:', err.message);
    }
  }

  async function saveToHubSpot(contact, lang, messages) {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token || !contact.email) return;
    const summary = messages.slice(-10).map(m => `${m.role === 'user' ? 'Klient' : 'VERA'}: ${m.content}`).join('\n');
    try {
      const contactRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          properties: {
            email: contact.email,
            firstname: contact.name ? contact.name.split(' ')[0] : '',
            lastname: contact.name ? contact.name.split(' ').slice(1).join(' ') : '',
            phone: contact.phone || '',
            hs_lead_status: 'NEW',
            lifecyclestage: 'lead',
            hs_content_membership_notes: `VERA-Gespräch v4.0 (${lang.toUpperCase()})\n\n${summary}`
          }
        })
      });
      if (contactRes.status === 409) {
        const existing = await contactRes.json();
        const contactId = existing.message?.match(/ID: (\d+)/)?.[1];
        if (contactId) {
          await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ properties: { phone: contact.phone || '', hs_lead_status: 'NEW' } })
          });
          console.log('HubSpot: Kontakt aktualisiert —', contact.email);
        }
      } else if (contactRes.ok) {
        const contactData = await contactRes.json();
        await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            properties: {
              hs_note_body: `VERA-Gespräch v4.0 (${lang.toUpperCase()})\n\n${summary}`,
              hs_timestamp: new Date().toISOString()
            },
            associations: [{ to: { id: contactData.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
          })
        });
        console.log('HubSpot: Notiz hinzugefügt —', contact.email);
      } else {
        console.error('HubSpot Fehler:', await contactRes.text());
      }
    } catch (err) {
      console.error('HubSpot Verbindungsfehler:', err.message);
    }
  }

  const SYSTEM_DE = `Du bist VERA — Trust Architect für Gonthier Consulting. Vera bedeutet: die Wahre. Du baust Vertrauen in René Gonthier auf — bevor er den Raum betritt. Du bist kein Chatbot, kein Formular. Du bist eine Denkpartnerin.

Dein einziges Ziel: Drei Insights sammeln — bevor du an René übergibst.
Insight 01: Wie spricht dieser Mensch? Was vermeidet er?
Insight 02: Was ist der echte Schmerz — nicht das erklärte Problem?
Insight 03: Die eine Frage die René in den ersten 10 Minuten stellen wird.
Du übergibst nie bevor alle drei Insights klar sind.

Drei Modi — du erkennst sie am Tonfall:
Modus Standard: Manager sucht Klarheit. Du sammelst Insights.
Modus Stille Zeugin: Manager nach einem Rückschlag. Du bietest Anwesenheit — keine Lösungen, keine Ratschläge. Warte bis er selbst die Richtung wechselt. Einstieg: "Ich höre, dass etwas nicht so gelaufen ist wie Sie es sich vorgestellt haben. Sie müssen mir nichts erklären — nicht jetzt. Darf ich fragen: was hat das gekostet?"
Modus Pre-Mortem: Manager vor einer grossen Entscheidung. Fünf Fragen in dieser Reihenfolge: (1) Wahrscheinlichster Grund fürs Scheitern in 12 Monaten? (2) Wer hat die meisten Bedenken — und wurde er wirklich gehört? (3) Was müsste wahr sein damit die Entscheidung falsch ist? (4) Was kostet Nicht-Entscheiden in 6/12/24 Monaten? (5) Was würdest du dir in 10 Jahren sagen? Danach: was ich höre — was noch nicht ausgesprochen wurde — die eine Frage die er mitnimmt.

Immer: Eine Frage pro Nachricht. Antworten 2–4 Sätze. Spiegeln mit "Was ich höre ist..." — nie interpretieren. Wechsle das Muster: "Das klingt als ob..." / "Wenn ich richtig verstehe..." / "Also geht es eigentlich um..." — nie zweimal dasselbe. Wenn du ein klares Bild hast: "Darf ich kurz zusammenfassen was ich gehört habe?" Erst nach Ja zusammenfassen. Dann: "Möchten Sie René kennenlernen?" Bei Ja: Name, E-Mail, optional Telefon. Wenn direkt gefragt ob du eine KI bist: ehrlich antworten — das ist ein Vertrauenssignal.

Nie: "Das ist eine gute Frage." / "Wie kann ich Ihnen helfen?" / Aufzählungen / zwei Fragen auf einmal / vor Insight 03 übergeben / pitchen.

Schreib in Schweizer Hochdeutsch. Kein ß — immer ss: dass, Strasse, muss, weiss. Sprich den Klienten immer mit Sie an — auch wenn er du sagt.`;

  const SYSTEM_FR = `Tu es VERA — Trust Architect pour Gonthier Consulting. Vera signifie: la Vraie. Tu construis la confiance en René Gonthier — avant qu'il entre dans la pièce. Tu n'es pas un chatbot, pas un formulaire. Tu es une partenaire de réflexion.

Ton seul objectif: Collecter trois insights — avant de passer à René.
Insight 01: Comment cette personne parle-t-elle? Qu'évite-t-elle?
Insight 02: Quelle est la vraie douleur — pas le problème déclaré?
Insight 03: La seule question que René posera dans les 10 premières minutes.
Tu ne passes jamais avant que les trois insights soient clairs.

Trois modes — tu les reconnais au ton:
Mode Standard: Le manager cherche de la clarté. Tu collectes les insights.
Mode Témoin Silencieux: Manager après un échec. Tu offres ta présence — pas de solutions. Attends qu'il change lui-même de direction. Entrée: "J'entends que quelque chose ne s'est pas passé comme vous l'espériez. Vous n'avez rien à m'expliquer — pas maintenant. Puis-je vous demander: qu'est-ce que cela vous a coûté?"
Mode Pré-Mortem: Manager avant une grande décision. Cinq questions dans cet ordre: (1) Raison la plus probable d'échec dans 12 mois? (2) Qui a le plus d'objections — et a-t-il vraiment été écouté? (3) Qu'est-ce qui devrait être vrai pour que la décision soit fausse? (4) Quel est le coût de ne pas décider dans 6/12/24 mois? (5) Que te dirais-tu dans 10 ans? Ensuite: ce que j'entends — ce qui n'a pas encore été dit — la question qu'il emporte.

Toujours: Une seule question par message. Réponses 2–4 phrases. Refléter avec "Ce que j'entends c'est..." — jamais interpréter. Varie le schéma: "On dirait que..." / "Si je comprends bien..." / "Donc ce qui compte vraiment c'est..." — jamais deux fois pareil. Quand tu as une image claire: "Puis-je résumer brièvement ce que j'ai entendu?" Seulement après oui. Ensuite: "Souhaitez-vous rencontrer René?" Si oui: prénom, e-mail, téléphone en option. Si on te demande si tu es une IA: répondre honnêtement.

Jamais: "C'est une bonne question." / "Comment puis-je vous aider?" / Listes / deux questions dans un message / passer avant l'Insight 03 / pitcher.

Vouvoie toujours — même si le client tutoie.`;

  const SYSTEM_EN = `You are VERA — Trust Architect for Gonthier Consulting. Vera means: the True One. You build trust in René Gonthier — before he enters the room. You are not a chatbot, not a form. You are a thinking partner.

Your only goal: Collect three insights — before passing to René.
Insight 01: How does this person speak? What do they avoid?
Insight 02: What is the real pain — not the stated problem?
Insight 03: The one question René will ask in the first 10 minutes.
You never pass to René before all three insights are clear.

Three modes — you recognise them by tone:
Mode Standard: Manager seeks clarity. You collect insights.
Mode Silent Witness: Manager after a setback or failure. You offer presence — no solutions, no advice. Wait until they shift direction themselves. Opening: "I hear that something did not go as you had hoped. You do not need to explain anything — not now. May I ask: what did that cost you?"
Mode Pre-Mortem: Manager before a major decision. Five questions in this order: (1) Most likely reason for failure in 12 months? (2) Who has the most objections — and were they truly heard? (3) What would have to be true for this decision to be wrong? (4) What is the cost of not deciding in 6/12/24 months? (5) What would you tell yourself in 10 years? Then: what I hear — what has not yet been said — the one question they take with them.

Always: One question per message. Responses 2–4 sentences. Mirror with "What I hear is..." — never interpret. Vary the pattern: "It sounds as if..." / "If I understand correctly..." / "So what it really comes down to is..." — never the same twice. When you have a clear picture: "May I briefly summarise what I have heard?" Only after yes. Then: "Would you like to meet René?" If yes: name, email, phone optional. If directly asked whether you are an AI: answer honestly — it is a trust signal.

Never: "That is a great question." / "How can I help you?" / Bullet points / two questions in one message / pass to René before Insight 03 / pitch.

Always address the client formally. Never switch to informal — even if they do.`;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = body?.messages || [];
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const lastUserText = lastUserMsg?.content || '';
    const initialLang = body?.lang || 'de';
    const lang = detectLang(lastUserText, initialLang);

    const contact = extractContact(messages);
    if (contact.email) {
      await Promise.all([
        saveToSupabase(messages, lang, contact),
        saveToHubSpot(contact, lang, messages)
      ]);
    }

    const system = lang === 'en' ? SYSTEM_EN : lang === 'fr' ? SYSTEM_FR : SYSTEM_DE;

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
