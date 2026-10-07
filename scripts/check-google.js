// Verificación de la conexión con Google Cloud / Google Wallet API.
// Solo lectura: no crea ni modifica nada en tu cuenta de emisor.
// Uso: node scripts/check-google.js
require('dotenv').config();
const { GoogleAuth } = require('google-auth-library');
const jwt = require('jsonwebtoken');

const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
const fail = (m) => { console.log(`❌ ${m}`); process.exitCode = 1; };

function leerCredenciales() {
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) { fail('GOOGLE_CREDENTIALS no está definida.'); return null; }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (err) {
    fail(`GOOGLE_CREDENTIALS no es JSON válido: ${err.message}`);
    warn('Suele pasar por saltos de línea sin escapar en private_key. Pegá el JSON en una sola línea.');
    return null;
  }
  for (const campo of ['client_email', 'private_key', 'project_id']) {
    if (!creds[campo]) { fail(`Al JSON de la service account le falta "${campo}".`); return null; }
  }
  if (!creds.private_key.includes('BEGIN PRIVATE KEY')) {
    fail('private_key no parece una clave PEM válida.');
    return null;
  }
  ok(`Credenciales OK — proyecto "${creds.project_id}", cuenta ${creds.client_email}`);
  return creds;
}

function revisarIds() {
  const { ISSUER_ID, CLASS_ID } = process.env;
  if (!ISSUER_ID) fail('ISSUER_ID no está definida.');
  else if (!/^\d+$/.test(ISSUER_ID)) warn(`ISSUER_ID="${ISSUER_ID}" no es numérico; normalmente son ~16 dígitos.`);
  else ok(`ISSUER_ID = ${ISSUER_ID}`);

  if (!CLASS_ID) fail('CLASS_ID no está definida.');
  else if (ISSUER_ID && !CLASS_ID.startsWith(`${ISSUER_ID}.`)) {
    fail(`CLASS_ID="${CLASS_ID}" debería empezar con "${ISSUER_ID}." para coincidir con el emisor.`);
  } else ok(`CLASS_ID = ${CLASS_ID}`);
  return { ISSUER_ID, CLASS_ID };
}

async function probarToken(credentials) {
  const auth = new GoogleAuth({ credentials, scopes: [SCOPE] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token?.token) throw new Error('Google no devolvió un access token.');
  ok('Autenticación con Google Cloud correcta (access token obtenido).');
  return client;
}

async function probarWallet(client, CLASS_ID) {
  const url = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/${encodeURIComponent(CLASS_ID)}`;
  try {
    const { data } = await client.request({ url, method: 'GET' });
    ok(`La clase de lealtad existe y es accesible: "${data.programName || CLASS_ID}"`);
  } catch (err) {
    const status = err.response?.status;
    const detalle = err.response?.data?.error?.message || err.message;
    if (status === 404) fail(`La clase ${CLASS_ID} no existe todavía. Creala en la Consola de Google Wallet.`);
    else if (status === 403) fail(`Sin permiso sobre el emisor. Autorizá ${'la service account'} en la Consola de Google Wallet. Detalle: ${detalle}`);
    else fail(`Error consultando la clase (HTTP ${status || '?'}): ${detalle}`);
  }
}

function probarFirma(credentials) {
  try {
    jwt.sign(
      { iss: credentials.client_email, aud: 'google', typ: 'savetowallet', iat: Math.floor(Date.now() / 1000), payload: {} },
      credentials.private_key,
      { algorithm: 'RS256' },
    );
    ok('La private_key firma correctamente el JWT de "Save to Wallet".');
  } catch (err) {
    fail(`No se pudo firmar el JWT con la private_key: ${err.message}`);
  }
}

(async () => {
  console.log('— Verificando conexión con Google Cloud —\n');
  const credentials = leerCredenciales();
  const { CLASS_ID } = revisarIds();
  if (!credentials) { console.log('\nCorregí lo anterior y volvé a correr.'); return; }
  probarFirma(credentials);
  try {
    const client = await probarToken(credentials);
    if (CLASS_ID) await probarWallet(client, CLASS_ID);
  } catch (err) {
    fail(`Fallo de autenticación: ${err.message}`);
    warn('Revisá que la service account esté activa y que la Wallet API esté habilitada en el proyecto.');
  }
  console.log(process.exitCode ? '\nHay problemas para resolver.' : '\nTodo listo: la conexión funciona.');
})();
