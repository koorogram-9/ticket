// 웹 푸시 알림 보내기 (VAPID 키는 환경변수에만 둬요)
const S = require("./store");

const PUBLIC = process.env.VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

const enabled = () => !!(PUBLIC && PRIVATE && S.enabled());

let wp = null;
function webpush() {
  if (!wp) {
    wp = require("web-push");
    wp.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
  }
  return wp;
}

// 구독 정보 검사: 브라우저가 준 endpoint 와 keys 만 받아요.
function cleanSub(s) {
  if (!s || typeof s !== "object" || !s.keys) return null;
  const endpoint = String(s.endpoint || "");
  const p256dh = String(s.keys.p256dh || "");
  const auth = String(s.keys.auth || "");
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return null;
  if (!/^[A-Za-z0-9_=-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_=-]{8,100}$/.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

// 한 동기화 코드에 연결된 모든 기기로 보내요. 만료된 구독은 지워요.
async function sendToCode(code, payloads) {
  const subs = await S.getSubs(code);
  if (!subs.length || !payloads.length) return { sent: 0, subs: subs.length };
  const keep = [];
  let sent = 0;
  for (const sub of subs) {
    let gone = false;
    for (const p of payloads) {
      try {
        await webpush().sendNotification(sub, JSON.stringify(p), { TTL: 86400, urgency: "normal" });
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          gone = true;
          break;
        }
      }
    }
    if (!gone) keep.push(sub);
  }
  if (keep.length !== subs.length) await S.saveSubs(code, keep);
  return { sent, subs: keep.length };
}

module.exports = { PUBLIC, enabled, cleanSub, sendToCode };
