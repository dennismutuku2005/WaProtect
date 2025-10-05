function normalizeJid(jid) {
  if (!jid) return "";
  return jid.split(":")[0].replace("@s.whatsapp.net", "").replace("@lid", "");
}

module.exports = {
  normalizeJid
};