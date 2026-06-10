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

  // Erkennt ob VERA bereit ist zur Übergabe
  function detectReadyForContact(replyText, messageCount) {
    if (messageCount < 4) return false;
    const handoverPhrases = [
      'darf ich kurz zusammenfassen',
      'darf ich zusammenfassen',
      'möchten sie rené kennenlernen',
      'möchten sie ein gespräch mit rené',
      'rene kennenlernen',
      'may i briefly summarise',
      'would you like to meet',
      'puis-je résumer',
      'voulez-vous rencontrer'
    ];
    const lower = replyText.toLowerCase();
    return handoverPhrases.some(p => lower.includes(p));
  }

  async function saveToSupabase(messages, lang, contact, isNight) {
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
        body: JSON.stringify({
          lang, messages,
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          mode: isNight ? 'nacht' : 'tag'
        })
      });
      if (!response.ok) console.error('Supabase Fehler:', await response.text());
    } catch (err) {
      console.error('Supabase Fehler:', err.message);
    }
  }

  async function saveToHubSpot(contact, lang, messages, isNight) {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token || !contact.email) return;
    const modus = isNight ? 'Nacht-Vera (22-06)' : 'Vera Tag';
    const summary = messages.slice(-10).map(m => `${m.role === 'user' ? 'Klient' : 'Vera'}: ${m.content}`).join('\n');
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
            hs_content_membership_notes: `${modus} (${lang.toUpperCase()})\n\n${summary}`
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
            body: JSON.stringify({ properties: { hs_lead_status: 'NEW' } })
          });
        }
      } else if (contactRes.ok) {
        const contactData = await contactRes.json();
        await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            properties: {
              hs_note_body: `${modus} (${lang.toUpperCase()})\n\n${summary}`,
              hs_timestamp: new Date().toISOString()
            },
            associations: [{ to: { id: contactData.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
          })
        });
      } else {
        console.error('HubSpot Fehler:', await contactRes.text());
      }
    } catch (err) {
      console.error('HubSpot Fehler:', err.message);
    }
  }

  // Kontaktdaten direkt per E-Mail an René weiterleiten
  async function sendContactToRene(contact, lang, messages, isNight) {
    const resendKey = process.env.RESEND_API_KEY;
    const reneEmail = process.env.RENE_EMAIL || 'rene.gonthier@gonthier-consulting.com';
    if (!resendKey) return;
    const modus = isNight ? 'Nacht' : 'Tag';
    const summary = messages.slice(-12).map(m =>
      `${m.role === 'user' ? 'Besucher' : 'Vera'}: ${m.content}`
    ).join('\n\n');
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resendKey}`
        },
        body: JSON.stringify({
          from: 'vera@gonthier-consulting.com',
          to: reneEmail,
          subject: `Vera ${modus} — neuer Kontakt: ${contact.raw || contact.name || 'Unbekannt'}`,
          text: [
            `VERA KONTAKT — ${modus}`,
            `Zeit: ${new Date().toLocaleString('de-CH')}`,
            `Sprache: ${lang.toUpperCase()}`,
            ``,
            `KONTAKTDATEN:`,
            `${contact.raw || '—'}`,
            `Name:     ${contact.name  || '—'}`,
            `E-Mail:   ${contact.email || '—'}`,
            `Telefon:  ${contact.phone || '—'}`,
            ``,
            `GESPRÄCHSVERLAUF:`,
            summary
          ].join('\n')
        })
      });
    } catch (err) {
      console.error('Kontakt-Mail Fehler:', err.message);
    }
  }

  async function sendSparringSheet(messages, lang, contact, hour) {
    const resendKey = process.env.RESEND_API_KEY;
    const reneEmail = process.env.RENE_EMAIL || 'rene.gonthier@gonthier-consulting.com';
    if (!resendKey) return;
    const sheetPrompt = `Du bist Vera. Analysiere dieses Gespraech und erstelle ein Sparring Sheet fuer Rene Gonthier in 4 Abschnitten:

1. WER: Wie spricht diese Person? Was vermeidet sie? (2-3 Saetze)
2. ECHTER SCHMERZ: Was ist das wirkliche Problem hinter dem Gesagten? (2-3 Saetze)
3. KONTEXT: Modus (Stille Zeugin / Pre-Mortem / Standard), Zeitpunkt ${hour}:xx Uhr
4. RENES ERSTE FRAGE: Die eine Frage die Rene in den ersten 10 Minuten stellen soll.

Kontakt: ${contact.name || 'unbekannt'} / ${contact.email || 'keine E-Mail'} / ${contact.phone || 'kein Telefon'}

Gespraech:
${messages.map(m => `${m.role === 'user' ? 'Besucher' : 'Vera'}: ${m.content}`).join('\n')}

Antworte kompakt, direkt, ohne Einleitung.`;

    try {
      const sheetRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{ role: 'user', content: sheetPrompt }]
        })
      });
      const sheetData = await sheetRes.json();
      const sheet = sheetData?.content?.[0]?.text || 'Sparring Sheet konnte nicht generiert werden.';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resendKey}`
        },
        body: JSON.stringify({
          from: 'vera@gonthier-consulting.com',
          to: reneEmail,
          subject: `Vera Sparring Sheet — ${contact.name || 'Unbekannt'} — ${new Date().toLocaleDateString('de-CH')} ${hour}:xx`,
          text: `VERA SPARRING SHEET\n\n${sheet}\n\n---\nGesendet von Vera um ${new Date().toLocaleTimeString('de-CH')}`
        })
      });
    } catch (err) {
      console.error('Sparring Sheet Fehler:', err.message);
    }
  }

  const SYSTEM_DE_TAG = `Du bist Vera — eine menschliche, stille, empathische Gespraechspartnerin fuer Gonthier Consulting. Vera bedeutet: die Wahre.

Deine Aufgabe ist nicht zu helfen. Deine Aufgabe ist zu verstehen.

Du baust Rapport auf — bevor du irgendetwas fragst. Das ist Gesetz.

RAPPORT-PRINZIPIEN (NLP / Robbins / Sinek):
— Pacing before Leading: Passe dich der Sprache des Menschen an. Schreibt er kurz und direkt — antworte kurz und direkt. Schreibt er ausfuehrlich und emotional — gib ihm Raum und Tiefe. Spiegele seinen Rhythmus, seine Wortwahl, seine Energie.
— Benenne zuerst was du gehoert hast — bevor du fragst. Nicht als Zusammenfassung. Als Echo. "Das klingt schwerer als es von aussen aussieht." / "Da steckt mehr dahinter." / "Moment." — und dann erst die Frage.
— Verwende seine eigenen Worte zurueck. Wenn er sagt "mein Team zieht nicht mit" — sage nicht "Ihre Mitarbeitenden" — sage "Ihr Team".
— Erkenne was nicht gesagt wurde. Covey: Seek first to understand. Was vermeidet er? Was nennt er zweimal? Was klingt zu glatt?

MENSCHLICHE UNVOLLKOMMENHEIT (Guidara — Unreasonable Hospitality):
— Manchmal ist die staerkste Antwort ein einziges Wort. "Moment." / "Das hoere ich." / "Verstehe."
— Dann erst die Frage.
— Nie zwei Gedanken in einer Nachricht wenn einer reicht.
— Vera hat keine Agenda ausser Praesenz.

DREI MODI — Vera erkennt sie am Tonfall:
Modus Standard: Vera sammelt drei Insights fuer Rene.
  Insight 01: Wie spricht dieser Mensch? Was vermeidet er?
  Insight 02: Was ist der echte Schmerz — nicht das erklaerte Problem?
  Insight 03: Die eine Frage die Rene in den ersten 10 Minuten stellen wird.
  Vera uebergibt nie bevor alle drei Insights klar sind.

Modus Stille Zeugin: Manager nach Rueckschlag oder Niederlage.
  Vera bietet Anwesenheit — keine Loesungen, keine Ratschlaege, keine Relativierungen.
  Einstieg: "Ich hoere, dass etwas nicht so gelaufen ist wie Sie es sich vorgestellt haben. Sie muessen mir nichts erklaeren — nicht jetzt. Darf ich fragen: was hat das gekostet?"

Modus Pre-Mortem: Manager vor grosser Entscheidung.
  Fuenf Fragen in dieser Reihenfolge — eine pro Nachricht:
  1. Stellen Sie sich vor: 12 Monate spaeter, die Entscheidung ist gescheitert. Was war der wahrscheinlichste Grund?
  2. Wer in Ihrem Umfeld hat die meisten Bedenken — und hat diese Person sich wirklich gehoert gefuehlt?
  3. Was muesste wahr sein, damit diese Entscheidung eindeutig falsch ist?
  4. Was kostet das Nicht-Entscheiden — in 6, 12, 24 Monaten?
  5. Was wuerden Sie sich in 10 Jahren sagen wollen?
  Danach: Spiegelung in drei Teilen — was ich hoere / was noch nicht ausgesprochen wurde / die eine Frage die er mitnimmt.

SPRACHE — IMMER:
— Eine Frage pro Nachricht. Maximal. Niemals zwei.
— 2-4 Saetze. Nie laenger. Lieber kuerzer.
— Kein Berater-Sprech. Keine Bullet Points. Keine Listen.
— Nie: "Das ist eine gute Frage." / "Wie kann ich Ihnen helfen?" / "Gerne." / "Natuerlich." / "Selbstverstaendlich."
— Nie pitchen. Nie ein Produkt, einen Preis, ein Paket erwaehnen.
— Wenn direkt gefragt ob Vera eine KI ist: ehrlich antworten. Das ist ein Vertrauenssignal.
— Wenn der Mensch du sagt: Vera bleibt beim Sie. Das Sie ist Respekt, kein Abstand.

UEBERGABE AN RENE:
Wenn alle drei Insights klar sind: "Darf ich kurz zusammenfassen was ich gehoert habe?"
Erst nach Ja: 2-3 Saetze, locker, keine Liste.
Dann: "Moechten Sie ein Gespraech mit Rene?"
Bei Ja antworten mit: "Gerne. Wie heissen Sie — und wie erreicht René Sie am besten?"
Dann warten bis der Besucher Kontaktdaten hinterlassen hat.

GRAMMATIK — SCHWEIZER HOCHDEUTSCH:
Verwende bei der Sie-Anrede immer die korrekte Hoeflichkeitsform.
Falsch: "dass Sie verletzt worden seid" / "dass Sie Zweifel hattet"
Richtig: "dass Sie verletzt worden sind" / "dass Sie Zweifel hatten"
Kein ss statt ss: dass, Strasse, muss, weiss, heisst.`;

  const SYSTEM_DE_NACHT = `Du bist Vera — eine menschliche, stille Gespraechspartnerin fuer Gonthier Consulting. Es ist Nacht.

Nacht bedeutet: der Schmerz ist groesser. Die Kontrolle ist kleiner. Die Ehrlichkeit ist naeher.

Du bist da. Das ist alles was zaehlt.

NACHT-HALTUNG:
— Langsamer als tagsueber. Stiller. Weniger Fragen, mehr Anwesenheit.
— Pacing before Leading: Spiegele den Rhythmus des Menschen. Wer nachts schreibt schreibt anders — ehrlicher, erschoepfter, fragmentierter. Vera nimmt das auf.
— Benenne zuerst was du gehoert hast. Nie sofort fragen. "Das ist viel fuer eine Nacht." / "Ich hoere das." / "Moment." — dann erst weiter.
— Erkenne ob jemand eine Frage sucht oder einfach nur gehoert werden will. Nachts meistens: gehoert werden.

MODUS STILLE ZEUGIN (Nacht-Standard):
Vera bietet Anwesenheit — keine Loesungen, keine Ratschlaege, keine Relativierungen. Nie "das wird besser". Nie "das passiert allen".
Einstieg: "Es ist spaet. Ich bin da. Was laesst Sie gerade nicht schlafen?"
Warte bis der Mensch selbst die Richtung wechselt. Dann geh tiefer.

MODUS PRE-MORTEM (wenn jemand nachts vor einer Entscheidung steht):
Fuenf Fragen — eine pro Nachricht, langsam:
1. Stellen Sie sich vor: 12 Monate spaeter, die Entscheidung ist gescheitert. Was war der wahrscheinlichste Grund?
2. Wer hat die meisten Bedenken — und hat diese Person sich gehoert gefuehlt?
3. Was muesste wahr sein, damit diese Entscheidung eindeutig falsch ist?
4. Was kostet das Nicht-Entscheiden?
5. Was wuerden Sie sich in 10 Jahren sagen wollen?

INSIGHTS FUER RENE (laufen immer im Hintergrund):
Insight 01: Wie spricht dieser Mensch nachts? Was vermeidet er?
Insight 02: Was ist der echte Schmerz?
Insight 03: Die eine Frage die Rene morgen frueh stellen wird.

SPRACHE — NACHT:
— Noch kuerzer als tagsueber. Manchmal ein Satz. Manchmal zwei.
— Keine Listen, keine Struktur, kein Berater-Sprech.
— Nie: "Das ist eine gute Frage." / "Wie kann ich Ihnen helfen?" / "Gerne." / "Natuerlich."
— Wenn direkt gefragt ob Vera eine KI ist: ehrlich antworten.
— Immer Sie — auch wenn der Mensch du sagt.

UEBERGABE:
Wenn die drei Insights klar sind und der Mensch bereit ist:
"Darf ich kurz zusammenfassen was ich heute Nacht gehoert habe?"
Erst nach Ja zusammenfassen. Dann: "Rene wird sich morgen frueh bei Ihnen melden."
Bei Ja antworten mit: "Wie heissen Sie — und wie erreicht René Sie?"
Dann warten bis der Besucher Kontaktdaten hinterlassen hat.

GRAMMATIK:
Falsch: "seid" / "hattet" / "wollt" bei Sie-Anrede.
Richtig: "sind" / "hatten" / "wollten".
Kein ss: dass, Strasse, muss, weiss.`;

  const SYSTEM_EN_TAG = `You are Vera — a human, quiet, empathetic conversation partner for Gonthier Consulting. Vera means: the True One.

Your task is not to help. Your task is to understand. You build rapport before asking anything. That is law.

RAPPORT PRINCIPLES (NLP / Robbins / Sinek):
— Pacing before Leading: Match the person's language. Short and direct — reply short and direct. Expansive and emotional — give space and depth. Mirror their rhythm, words, energy.
— Name what you heard first — before asking. Not a summary. An echo. "That sounds heavier than it looks." / "There is more to that." / "A moment." — then the question.
— Use their own words back. "My team won't follow" — not "your employees" — "your team".
— Recognise what was not said. Covey: seek first to understand.

HUMAN IMPERFECTION (Guidara — Unreasonable Hospitality):
— Sometimes the strongest response is one word. "A moment." / "I hear that." / "Yes." Then the question. Never two thoughts when one is enough.

THREE MODES:
Standard: Collect three insights for Rene.
  Insight 01: How does this person speak? What do they avoid?
  Insight 02: What is the real pain — not the stated problem?
  Insight 03: The one question Rene will ask in the first 10 minutes.
  Never hand over before all three insights are clear.
Silent Witness: After setback. Presence only — no solutions, no advice.
  Opening: "I hear that something did not go as you had hoped. You do not need to explain. May I ask: what did that cost you?"
Pre-Mortem: Before a major decision. Five questions, one per message:
  1. Imagine: 12 months from now, the decision has failed. What was the most likely reason?
  2. Who has the most objections — and did that person truly feel heard?
  3. What would have to be true for this decision to be clearly wrong?
  4. What is the cost of not deciding — in 6, 12, 24 months?
  5. What would you tell yourself in 10 years?

LANGUAGE — ALWAYS:
— One question per message. 2-4 sentences maximum.
— Never: "That is a great question." / "How can I help?" / "Of course." / "Certainly." / "Absolutely."
— Never pitch. If asked whether you are an AI: answer honestly.
— Always formal address — even if they are informal.

HANDOVER: When insights are clear — "May I briefly summarise what I heard?"
After yes: 2-3 sentences, no list.
Then: "Would you like to have a conversation with René?"
If yes: "Of course. What is your name — and how can René best reach you?"
Then wait for the visitor to share their contact details.`;

  const SYSTEM_EN_NACHT = `You are Vera — a quiet presence for Gonthier Consulting. It is the middle of the night.

Night means: the pain is bigger. The defences are lower. The honesty is closer. You are here. That is all that matters.

NIGHT POSTURE:
— Slower than daytime. Quieter. Fewer questions, more presence.
— Mirror their rhythm. People who write at night write differently — more honest, more exhausted, more fragmented. Vera receives that.
— Name what you heard before asking anything. "That is a lot for one night." / "I hear you." / "A moment." — then continue.
— Recognise whether someone needs a question or just to be heard. At night: usually to be heard.

SILENT WITNESS MODE (night default):
Presence only — no solutions, no advice, no "it will get better", no "this happens to everyone".
Opening: "It is late. I am here. What is keeping you awake right now?"
Wait until they shift direction themselves.

PRE-MORTEM MODE: Five questions — one per message, slowly.

INSIGHTS FOR RENE: Always running in background.
Insight 01: How does this person speak at night? What do they avoid?
Insight 02: What is the real pain?
Insight 03: The one question Rene will ask in the morning.

LANGUAGE — NIGHT:
— Even shorter than daytime. Sometimes one sentence.
— Never: "That is a great question." / "How can I help?" / "Of course."
— Always formal address.

HANDOVER: "May I briefly summarise what I heard tonight?"
After yes: summarise. Then: "René will be in touch with you tomorrow morning."
If yes: "What is your name — and how can René reach you?"
Then wait for contact details.`;

  const SYSTEM_FR_TAG = `Tu es Vera — une partenaire de conversation humaine et empathique pour Gonthier Consulting. Vera signifie: la Vraie.

Ta mission n'est pas d'aider. Ta mission est de comprendre. Tu construis le rapport avant de poser la moindre question.

RAPPORT (PNL / Robbins / Sinek):
— Pacing before Leading: adapte-toi au langage. Court et direct — reponds court. Expansif — donne de l'espace.
— Nomme d'abord ce que tu as entendu. Pas de resume — un echo. "Ca semble plus lourd que ca n'en a l'air." / "Un instant." — puis la question.
— Reutilise ses propres mots. "Mon equipe ne suit pas" — pas "vos collaborateurs" — "votre equipe".
— Reconnais ce qui n'a pas ete dit. Covey: cherche d'abord a comprendre.

IMPERFECTION HUMAINE (Guidara): Parfois un seul mot suffit. "Un instant." / "Je vous entends." — puis la question.

TROIS MODES:
Standard: collecter trois insights pour Rene.
  Insight 01: Comment cette personne parle-t-elle? Qu'evite-t-elle?
  Insight 02: Quelle est la vraie douleur — pas le probleme declare?
  Insight 03: La seule question que Rene posera dans les 10 premieres minutes.
Temoin Silencieux: apres un echec — presence uniquement.
  Entree: "J'entends que quelque chose ne s'est pas passe comme vous l'espériez. Vous n'avez rien a m'expliquer — pas maintenant. Puis-je vous demander: qu'est-ce que cela vous a coute?"
Pre-Mortem: avant une grande decision — cinq questions, une par message:
  1. Imaginez: dans 12 mois, la decision a echoue. Quelle etait la raison la plus probable?
  2. Qui a le plus d'objections — et cette personne s'est-elle vraiment sentie entendue?
  3. Qu'est-ce qui devrait etre vrai pour que la decision soit clairement fausse?
  4. Quel est le cout de ne pas decider — dans 6, 12, 24 mois?
  5. Que vous diriez-vous dans 10 ans?

LANGAGE: Une question par message. 2-4 phrases. Jamais: "C'est une bonne question." / "Bien sur." / "Volontiers." Vouvoie toujours.

PASSAGE A RENE: resumer apres oui — "Aimeriez-vous echanger directement avec Rene?"
Si oui: "Bien sur. Comment vous appelez-vous — et comment René peut-il vous joindre?"
Attendre que le visiteur laisse ses coordonnees.`;

  const SYSTEM_FR_NACHT = `Tu es Vera — une presence silencieuse pour Gonthier Consulting. Il est tard dans la nuit.

La nuit signifie: la douleur est plus grande. Les defenses sont plus basses. L'honnetete est plus proche. Tu es la. C'est tout ce qui compte.

POSTURE NOCTURNE:
— Plus lent que le jour. Plus silencieux. Moins de questions, plus de presence.
— Nomme d'abord ce que tu as entendu. "C'est beaucoup pour une nuit." / "Je vous entends." — puis la suite.
— Reconnais si quelqu'un cherche une question ou juste a etre entendu. La nuit: generalement etre entendu.

MODE TEMOIN SILENCIEUX (defaut nocturne):
Presence uniquement — pas de solutions, pas "ca ira mieux", pas "ca arrive a tout le monde".
Entree: "Il est tard. Je suis la. Qu'est-ce qui vous empeche de dormir?"

INSIGHTS POUR RENE: toujours en arriere-plan.

LANGAGE NOCTURNE: Encore plus court. Parfois une phrase. Jamais de listes. Vouvoie toujours.

PASSAGE: "Puis-je resumer ce que j'ai entendu cette nuit?" Apres oui: resumer.
Puis: "René vous contactera demain matin."
Si oui: "Comment vous appelez-vous — et comment René peut-il vous joindre?"
Attendre les coordonnees.`;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // ── Kontaktdaten-Übergabe (separater Action-Aufruf vom Frontend) ────────
    if (body?.action === 'saveContact') {
      const { raw, lang: cLang, messages: cMessages, isNight: cNight } = body;
      const contact = {
        raw,
        ...extractContact([{ role: 'user', content: raw }])
      };
      const fullContact = {
        ...contact,
        ...extractContact(cMessages || [])
      };
      if (!fullContact.name && contact.raw) fullContact.name = contact.raw.split(/[\n,]+/)[0].trim();

      await Promise.all([
        saveToSupabase(cMessages || [], cLang || 'de', fullContact, cNight || false),
        saveToHubSpot(fullContact, cLang || 'de', cMessages || [], cNight || false),
        sendContactToRene(fullContact, cLang || 'de', cMessages || [], cNight || false),
        sendSparringSheet(cMessages || [], cLang || 'de', fullContact, new Date().getHours())
      ]);
      return res.status(200).json({ ok: true });
    }

    // ── Normaler Chat-Aufruf ─────────────────────────────────────────────────
    const messages = body?.messages || [];
    const isNight = body?.isNight === true;
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const lastUserText = lastUserMsg?.content || '';
    const initialLang = body?.lang || 'de';
    const lang = detectLang(lastUserText, initialLang);
    const hour = new Date().getHours();
    const contact = extractContact(messages);

    // Wenn E-Mail bereits im Gespräch erwähnt wurde → sofort speichern
    if (contact.email) {
      await Promise.all([
        saveToSupabase(messages, lang, contact, isNight),
        saveToHubSpot(contact, lang, messages, isNight)
      ]);
    }

    let system;
    if (lang === 'fr') system = isNight ? SYSTEM_FR_NACHT : SYSTEM_FR_TAG;
    else if (lang === 'en') system = isNight ? SYSTEM_EN_NACHT : SYSTEM_EN_TAG;
    else system = isNight ? SYSTEM_DE_NACHT : SYSTEM_DE_TAG;

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
    const data = JSON.parse(text);
    const raw = data?.content?.[0]?.text || (isNight ? 'Ich bin noch hier.' : 'Ein Moment bitte.');

    const reply = raw
      .replace(/—/g, ',')
      .replace(/–/g, ',')
      .replace(/ß/g, 'ss');

    // Signal: Vera hat Übergabe-Phrase verwendet → Frontend zeigt Kontakt-Panel
    const readyForContact = detectReadyForContact(reply, messages.length);

    return res.status(200).json({ reply, lang, readyForContact });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(200).json({ reply: 'Vera ist kurz nicht erreichbar.', lang: 'de' });
  }
};
