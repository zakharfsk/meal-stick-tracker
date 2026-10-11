// Every minute: look at plans whose next reminder is due, push it, mark it done.
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 2 });

const APP_URL = "https://zakharfsk.github.io/meal-stick-tracker/";
const ICON = APP_URL + "icons/icon-192.png";
const LATE_MS = 20 * 60 * 1000; // a reminder older than this is skipped, not sent late

exports.reminders = onSchedule({ schedule: "every 1 minutes", timeZone: "Europe/Sofia" }, async () => {
  const db = admin.firestore();
  const now = Date.now();
  const snap = await db.collection("plans").where("nextAt", "<=", now).get();
  for (const doc of snap.docs) {
    const p = doc.data();
    const tokens = Array.isArray(p.tokens) ? p.tokens : [];
    const items = Array.isArray(p.items) ? p.items : []; // [{at, title, body, id}]
    const notified = p.notified || {};
    const due = items.filter(i => i.at <= now && !notified[i.id]);
    const updates = { notified: { ...notified } };
    const badTokens = new Set();
    for (const it of due) {
      updates.notified[it.id] = now;
      if (now - it.at > LATE_MS || !tokens.length) continue;
      const res = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title: it.title, body: it.body },
        data: { kind: it.kind || "meal", id: String(it.id) },
        webpush: {
          headers: { Urgency: "high", TTL: "1200" },
          notification: { title: it.title, body: it.body, icon: ICON, badge: ICON, tag: "mst-" + it.kind, renotify: true },
          fcmOptions: { link: APP_URL },
        },
      });
      res.responses.forEach((r, i) => {
        if (!r.success) {
          const code = r.error && r.error.code;
          if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument") badTokens.add(tokens[i]);
        }
      });
    }
    // next due time among items not yet notified
    const rest = items.filter(i => !updates.notified[i.id]).map(i => i.at);
    updates.nextAt = rest.length ? Math.min(...rest) : null;
    if (badTokens.size) updates.tokens = tokens.filter(t => !badTokens.has(t));
    await doc.ref.set(updates, { merge: true });
  }
});
