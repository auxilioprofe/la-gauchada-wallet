require('dotenv').config();
const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { createClient } = require('@libsql/client');
const cookieSession = require('cookie-session');

const app = express();
// Render (y cualquier proxy TLS) reenvía por HTTP interno con X-Forwarded-Proto.
// Sin esto, req.protocol devuelve 'http' y el QR de /qr codifica una URL http://.
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'gauchada-secret'],
  maxAge: 8 * 60 * 60 * 1000,
}));

function requireAuth(req, res, next) {
  if (req.session.autenticado) return next();
  res.redirect('/login');
}

const ISSUER_ID = process.env.ISSUER_ID;
// Normalizado: un espacio o un salto de línea de más al pegarla en el panel del
// proveedor rompía la comparación exacta del login sin ninguna pista de por qué.
const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || '').trim();
const CLASS_ID = process.env.CLASS_ID;

// ── Base de datos Turso ────────────────────────────────────
if (!process.env.TURSO_URL) {
  console.warn('⚠️ TURSO_URL no está definida: usando archivo local gauchada.db (se pierde al reiniciar en Render). Configurá TURSO_URL y TURSO_TOKEN.');
}
const db = createClient({
  url: process.env.TURSO_URL || 'file:gauchada.db',
  authToken: process.env.TURSO_TOKEN,
});

async function inicializarDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS clientes (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      telefono TEXT DEFAULT '',
      sellos_totales INTEGER DEFAULT 0,
      empanadas_canjeadas INTEGER DEFAULT 0,
      creado_en TEXT DEFAULT (datetime('now'))
    )
  `);
  try { await db.execute(`ALTER TABLE clientes ADD COLUMN sellos_totales INTEGER DEFAULT 0`); } catch (e) {}
  try { await db.execute(`ALTER TABLE clientes ADD COLUMN empanadas_canjeadas INTEGER DEFAULT 0`); } catch (e) {}
}

function calcularPremios(cliente) {
  const sellos = Number(cliente.sellos_totales) || 0;
  const canjeadas = Number(cliente.empanadas_canjeadas) || 0;
  const ganadas = Math.floor(sellos / 10);
  const pendientes = ganadas - canjeadas;
  const disponibles = Math.min(pendientes, 3);
  const enEspera = Math.max(0, pendientes - disponibles);
  const progreso = sellos % 10;
  return { ganadas, canjeadas, pendientes, disponibles, enEspera, progreso };
}

async function obtenerCliente(id) {
  const result = await db.execute({ sql: 'SELECT * FROM clientes WHERE id = ?', args: [id] });
  return result.rows[0] || null;
}

async function crearCliente(cliente) {
  await db.execute({
    sql: 'INSERT INTO clientes (id, nombre, telefono, sellos_totales, empanadas_canjeadas) VALUES (?, ?, ?, 0, 0)',
    args: [cliente.id, cliente.nombre, cliente.telefono],
  });
}

async function agregarSellos(id, cantidad) {
  await db.execute({ sql: 'UPDATE clientes SET sellos_totales = sellos_totales + ? WHERE id = ?', args: [cantidad, id] });
}

async function canjearEmpanada(id) {
  await db.execute({ sql: 'UPDATE clientes SET empanadas_canjeadas = empanadas_canjeadas + 1 WHERE id = ?', args: [id] });
}

async function editarCliente(id, nombre, telefono, sellos_totales, empanadas_canjeadas) {
  await db.execute({
    sql: 'UPDATE clientes SET nombre = ?, telefono = ?, sellos_totales = ?, empanadas_canjeadas = ? WHERE id = ?',
    args: [nombre, telefono, sellos_totales, empanadas_canjeadas, id],
  });
}

async function eliminarCliente(id) {
  await db.execute({ sql: 'DELETE FROM clientes WHERE id = ?', args: [id] });
}

async function obtenerTodosLosClientes() {
  const result = await db.execute('SELECT * FROM clientes ORDER BY creado_en DESC');
  return result.rows;
}

let credentials = null;
try {
  if (process.env.GOOGLE_CREDENTIALS) {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } else {
    const fs = require('fs');
    const path = require('path');
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './service-account.json';
    const resolvedPath = path.resolve(credPath);
    if (fs.existsSync(resolvedPath)) {
      credentials = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    } else {
      console.warn("⚠️ Advertencia: No se encontró la variable de entorno GOOGLE_CREDENTIALS ni el archivo service-account.json. Las funciones de Google Wallet estarán desactivadas.");
    }
  }
} catch (e) {
  console.error("❌ Error al cargar credenciales de Google:", e.message);
}

const auth = credentials
  ? new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'] })
  : null;

function walletBody(cliente) {
  const { disponibles, enEspera, progreso } = calcularPremios(cliente);
  if (disponibles > 0) {
    let txt = `🎉 Tenés ${disponibles} empanada${disponibles > 1 ? 's' : ''} gratis para canjear`;
    if (enEspera > 0) txt += ` (y ${enEspera} más en espera)`;
    return txt;
  }
  return `${10 - progreso} sellos más para tu próxima empanada gratis`;
}

async function generarWalletLink(cliente) {
  if (!auth || !credentials) {
    console.warn("⚠️ Google Wallet no está configurado. Retornando enlace de simulación.");
    return `#/simulado-wallet-link?id=${cliente.id}`;
  }
  const objectId = `${ISSUER_ID}.cliente_${cliente.id}`;
  const { progreso } = calcularPremios(cliente);
  const client = await auth.getClient();
  const loyaltyObject = {
    id: objectId, classId: CLASS_ID, state: 'ACTIVE',
    accountId: String(cliente.id), accountName: cliente.nombre,
    loyaltyPoints: { balance: { int: progreso }, label: 'Sellos' },
    textModulesData: [{ header: 'Premio', body: walletBody(cliente), id: 'next_reward' }],
    barcode: { type: 'QR_CODE', value: String(cliente.id), alternateText: `#${cliente.id}` },
  };
  try {
    await client.request({ url: 'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject', method: 'POST', data: loyaltyObject });
  } catch (err) { if (err.response?.status !== 409) throw err; }
  const claims = { iss: credentials.client_email, aud: 'google', typ: 'savetowallet', iat: Math.floor(Date.now() / 1000), payload: { loyaltyObjects: [{ id: objectId }] } };
  const token = jwt.sign(claims, credentials.private_key, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}

// Devuelve true si la tarjeta quedó actualizada, false si Google Wallet no está
// configurado. Si el envío falla, relanza para que quien llama pueda avisarlo.
async function actualizarWallet(cliente) {
  if (!auth || !credentials) {
    console.warn("⚠️ Google Wallet no está configurado. No se pudo actualizar el wallet del cliente: " + cliente.id);
    return false;
  }
  const client = await auth.getClient();
  const objectId = `${ISSUER_ID}.cliente_${cliente.id}`;
  const { progreso } = calcularPremios(cliente);
  try {
    await client.request({
      url: `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${encodeURIComponent(objectId)}`,
      method: 'PATCH',
      data: {
        loyaltyPoints: { balance: { int: progreso }, label: 'Sellos' },
        textModulesData: [{ header: 'Premio', body: walletBody(cliente), id: 'next_reward' }],
      },
    });
  } catch (err) {
    // Un 404 acá suele significar que el objectId del PATCH no coincide con el
    // que se creó en el POST inicial. Logueamos el ID para poder compararlos.
    const status = err.response?.status;
    const detalle = err.response?.data?.error?.message || err.message;
    console.error(`Error wallet: PATCH ${objectId} falló (HTTP ${status || '?'}): ${detalle}`);
    throw err;
  }
  return true;
}

// ── RUTAS ──────────────────────────────────────────────────

const UI = {
  head: (title) => `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | La Gauchada</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      :root {
        --primary: #0ea5e9;
        --primary-dark: #0284c7;
        --primary-light: rgba(14, 165, 233, 0.15);
        --bg: #0f172a;
        --card-bg: #ffffff;
        --text: #0f172a;
        --text-muted: #64748b;
        --border: #e2e8f0;
        --success: #10b981;
        --warning: #f59e0b;
        --danger: #ef4444;
        --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
        --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
        --shadow-lg: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
        --shadow-xl: 0 25px 50px -12px rgb(0 0 0 / 0.25);
      }
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      body {
        font-family: 'Inter', -apple-system, sans-serif;
        background: radial-gradient(circle at top, #1e1b4b 0%, #0f172a 100%);
        color: var(--text);
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .card {
        background: var(--card-bg);
        border-radius: 24px;
        padding: 40px 32px;
        max-width: 440px;
        width: 100%;
        box-shadow: var(--shadow-xl);
        text-align: center;
        border: 1px solid rgba(255, 255, 255, 0.8);
        position: relative;
        overflow: hidden;
      }
      .card::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 6px;
        background: linear-gradient(90deg, var(--primary) 0%, var(--success) 100%);
      }
      .logo {
        font-size: 28px;
        font-weight: 800;
        color: var(--primary);
        letter-spacing: -0.5px;
        margin-bottom: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }
      .logo span {
        background: linear-gradient(to right, #0ea5e9, #10b981);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .subtitle {
        color: var(--text-muted);
        font-size: 15px;
        margin-bottom: 32px;
        font-weight: 500;
      }
      .form-group {
        text-align: left;
        margin-bottom: 20px;
      }
      label {
        display: block;
        font-size: 14px;
        font-weight: 600;
        color: #334155;
        margin-bottom: 8px;
      }
      input {
        width: 100%;
        padding: 14px 18px;
        border: 2px solid var(--border);
        border-radius: 16px;
        font-size: 16px;
        outline: none;
        font-family: inherit;
        transition: all 0.2s ease;
        background: #f8fafc;
      }
      input:focus {
        border-color: var(--primary);
        background: #ffffff;
        box-shadow: 0 0 0 4px var(--primary-light);
      }
      button, .btn {
        width: 100%;
        padding: 16px;
        background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
        color: white;
        border: none;
        border-radius: 16px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        text-decoration: none;
        transition: all 0.2s ease;
        box-shadow: 0 4px 12px rgba(14, 165, 233, 0.25);
      }
      button:hover, .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 12px 20px rgba(14, 165, 233, 0.4);
      }
      button:active, .btn:active {
        transform: translateY(0);
      }
      .btn-secondary {
        background: #f1f5f9;
        color: #475569;
        box-shadow: none;
      }
      .btn-secondary:hover {
        background: #e2e8f0;
        color: #1e293b;
        box-shadow: none;
      }
      .error {
        background: #fef2f2;
        color: var(--danger);
        border: 1px solid #fee2e2;
        padding: 14px;
        border-radius: 16px;
        font-size: 14px;
        margin-bottom: 20px;
        font-weight: 500;
        text-align: center;
      }
    </style>
  `
};

app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head>${UI.head('Acceso Panel')}</head><body><div class="card"><div class="logo"><span>LA GAUCHADA</span> 🥟</div><div class="subtitle">Acceso seguro al panel</div>${req.query.error === '2' ? '<div class="error">⚙️ El servidor no tiene PANEL_PASSWORD configurada. Cargala en las variables de entorno y reintentá.</div>' : req.query.error ? '<div class="error">🔑 Contraseña incorrecta</div>' : ''}<form action="/login" method="POST"><div class="form-group"><label>Contraseña administrativa</label><input type="password" name="password" placeholder="••••••••" required autofocus></div><button type="submit">Entrar al panel →</button></form></div></body></html>`);
});

app.post('/login', (req, res) => {
  // Sin contraseña configurada el panel queda cerrado, nunca abierto con una
  // contraseña de respaldo fija: la URL es pública y desde el panel se otorgan
  // sellos y se canjean premios.
  if (!PANEL_PASSWORD) return res.redirect('/login?error=2');
  const ingresada = (req.body.password || '').trim();
  if (ingresada && ingresada === PANEL_PASSWORD) { req.session.autenticado = true; res.redirect('/panel'); }
  else res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

app.get('/registro', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head>${UI.head('Club de Lealtad')}<style>.promo { background: linear-gradient(135deg, #e0f2fe 0%, #f0f9ff 100%); border: 1px solid rgba(14, 165, 233, 0.2); border-radius: 18px; padding: 20px; margin-bottom: 28px; text-align: left; display: flex; gap: 12px; align-items: flex-start; } .promo-icon { font-size: 24px; } .promo-text h4 { font-weight: 700; color: #0369a1; margin-bottom: 4px; } .promo-text p { font-size: 13px; color: #0e7490; line-height: 1.4; } .footer-text { margin-top: 24px; font-size: 12px; color: var(--text-muted); font-weight: 500; }</style></head><body><div class="card"><div class="logo"><span>LA GAUCHADA</span> 🥟</div><div class="subtitle">Club de Lealtad</div><div class="promo"><div class="promo-icon">🎁</div><div class="promo-text"><h4>¡Empanada de Regalo!</h4><p>Acumulá 10 sellos en tus compras y obtené una empanada completamente gratis.</p></div></div><form action="/registro" method="POST"><div class="form-group"><label>Nombre completo</label><input type="text" name="nombre" placeholder="Ej. Juan Pérez" required maxlength="100"></div><div class="form-group"><label>Teléfono <span style="font-weight: normal; color: var(--text-muted);">(opcional)</span></label><input type="tel" name="telefono" placeholder="Ej. +54 9 11 1234 5678" maxlength="20"></div><button type="submit">Registrarme gratis →</button></form><div class="footer-text">Tu tarjeta de fidelidad se añade a tu celular</div></div></body></html>`);
});

app.post('/registro', async (req, res) => {
  const nombre = (req.body.nombre || '').trim().slice(0, 100);
  const telefono = (req.body.telefono || '').trim().slice(0, 20);
  if (!nombre) return res.status(400).send('El nombre es requerido.');
  const id = Date.now().toString(36).slice(-6).toUpperCase();
  try {
    await crearCliente({ id, nombre, telefono });
    const clienteCompleto = { id, nombre, telefono, sellos_totales: 0, empanadas_canjeadas: 0 };
    const walletLink = await generarWalletLink(clienteCompleto);
    res.send(`<!DOCTYPE html><html lang="es"><head>${UI.head('¡Bienvenido!')}<style>.welcome-icon { font-size: 48px; margin-bottom: 16px; animation: bounce 2s infinite; } @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } } h1 { font-size: 24px; color: #0f172a; margin-bottom: 8px; font-weight: 800; } p { color: var(--text-muted); margin-bottom: 32px; font-size: 15px; line-height: 1.5; } .wallet-btn { display: inline-flex; background: #000000; color: #ffffff; padding: 0 24px; height: 56px; align-items: center; border-radius: 28px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: var(--shadow-md); transition: all 0.2s ease; border: 1px solid #333333; margin-bottom: 24px; } .wallet-btn:hover { background: #111111; transform: translateY(-2px); box-shadow: 0 8px 16px rgba(0,0,0,0.3); } .wallet-btn svg { margin-right: 12px; } .id-badge { background: #f8fafc; border: 1px dashed var(--border); border-radius: 12px; padding: 12px; font-size: 13px; color: var(--text-muted); font-family: monospace; font-weight: 600; }</style></head><body><div class="card"><div class="welcome-icon">🎉</div><h1>¡Bienvenido, ${nombre}!</h1><p>Tu cuenta del Club La Gauchada ha sido creada. Agregá tu tarjeta digital para acumular sellos.</p><a class="wallet-btn" href="${walletLink}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19 4H5C3.89 4 3.01 4.89 3.01 6L3 18C3 19.11 3.89 20 5 20H19C20.11 20 21 19.11 21 18V6C21 4.89 20.11 4 19 4ZM19 18H5V12H19V18ZM19 8H5V6H19V8Z" fill="#FFFFFF"/><path d="M12 14.5C12.83 14.5 13.5 13.83 13.5 13C13.5 12.17 12.83 11.5 12 11.5C11.17 11.5 10.5 12.17 10.5 13C10.5 13.83 11.17 14.5 12 14.5Z" fill="#0EA5E9"/></svg>Añadir a Google Wallet</a><div class="id-badge">ID de Cliente: #${id}</div></div></body></html>`);
  } catch (err) { console.error(err); res.status(500).send('Error al crear la tarjeta. Intentá de nuevo.'); }
});

app.get('/panel', requireAuth, async (req, res) => {
  const clientes = await obtenerTodosLosClientes();
  const lista = clientes.map(c => {
    const { progreso, disponibles, pendientes } = calcularPremios(c);
    return `<tr>
      <td><span class="client-id">#${c.id}</span></td>
      <td><span class="client-name">${c.nombre}</span></td>
      <td><span class="client-tel">${c.telefono || '-'}</span></td>
      <td>
        <div class="stamps-badge ${disponibles > 0 ? 'completed' : ''}">
          <span>Sellos:</span>
          <strong>${progreso}/10</strong>
        </div>
        ${disponibles > 0 ? `<span class="reward-pill">🎁 ${disponibles} Canje${disponibles > 1 ? 's' : ''}</span>` : ''}
        ${pendientes > 3 ? `<span class="reward-pill" style="background:#fef3c7;color:#d97706;">(+${pendientes - 3} en espera)</span>` : ''}
      </td>
      <td>
        <div class="actions">
          ${disponibles > 0 ? `
            <form action="/canjear" method="POST" style="margin:0">
              <input type="hidden" name="id" value="${c.id}">
              <button type="submit" class="action-btn action-btn-claim">🎁 Canjear</button>
            </form>
          ` : ''}
          <a href="/editar/${c.id}" class="action-btn action-btn-edit">✏️ Editar</a>
          <form action="/eliminar/${c.id}" method="POST" style="margin:0" onsubmit="return confirm('¿Seguro que querés eliminar a ${c.nombre}?')">
            <button type="submit" class="action-btn action-btn-delete">🗑️</button>
          </form>
        </div>
      </td>
    </tr>`;
  }).join('');
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Panel de Administración | La Gauchada</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet"><style>:root { --primary: #0ea5e9; --primary-dark: #0284c7; --bg: #f8fafc; --card-bg: #ffffff; --text: #0f172a; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --warning: #f59e0b; --danger: #ef4444; } * { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: 'Inter', -apple-system, sans-serif; background: #f1f5f9; color: var(--text); min-height: 100vh; padding: 40px 20px; } .container { max-width: 1000px; margin: 0 auto; } header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; } h1 { font-size: 28px; font-weight: 800; display: flex; align-items: center; gap: 10px; } h1 span { background: linear-gradient(to right, #0ea5e9, #10b981); -webkit-background-clip: text; -webkit-text-fill-color: transparent; } .nav { display: flex; gap: 12px; } .nav a { padding: 12px 20px; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 600; transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 8px; } .btn-primary { background: var(--primary); color: white; box-shadow: 0 4px 12px rgba(14, 165, 233, 0.2); } .btn-primary:hover { background: var(--primary-dark); transform: translateY(-2px); box-shadow: 0 8px 16px rgba(14, 165, 233, 0.3); } .btn-secondary { background: white; color: var(--text-muted); border: 1px solid var(--border); } .btn-secondary:hover { background: #f8fafc; color: var(--text); transform: translateY(-2px); } .table-container { background: white; border-radius: 20px; box-shadow: 0 10px 30px -5px rgba(0,0,0,0.05); border: 1px solid var(--border); overflow: hidden; } table { width: 100%; border-collapse: collapse; text-align: left; } th { background: #f8fafc; color: var(--text-muted); font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; padding: 16px 24px; border-bottom: 1px solid var(--border); } td { padding: 18px 24px; border-bottom: 1px solid var(--border); font-size: 15px; } tr:last-child td { border-bottom: none; } .client-id { font-family: monospace; background: #f1f5f9; padding: 4px 8px; border-radius: 6px; font-weight: 600; color: var(--text-muted); } .client-name { font-weight: 600; color: #1e293b; } .client-tel { color: var(--text-muted); } .stamps-badge { display: inline-flex; align-items: center; background: #f0f9ff; color: #0369a1; padding: 6px 12px; border-radius: 9999px; font-size: 14px; font-weight: 700; gap: 6px; border: 1px solid #e0f2fe; } .stamps-badge.completed { background: #ecfdf5; color: #047857; border-color: #d1fae5; } .reward-pill { background: #fef3c7; color: #d97706; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 700; margin-left: 8px; border: 1px solid #fde68a; } .actions { display: flex; gap: 8px; align-items: center; } .action-btn { padding: 8px 12px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; font-size: 13px; transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 4px; text-decoration: none; } .action-btn-claim { background: var(--success); color: white; } .action-btn-claim:hover { background: #059669; transform: scale(1.05); } .action-btn-edit { background: #f1f5f9; color: #475569; } .action-btn-edit:hover { background: #e2e8f0; color: #1e293b; } .action-btn-delete { background: #fff5f5; color: var(--danger); } .action-btn-delete:hover { background: var(--danger); color: white; } .empty-state { text-align: center; padding: 60px 40px; color: var(--text-muted); } .empty-state-icon { font-size: 48px; margin-bottom: 16px; }</style></head><body><div class="container"><header><h1><span>Panel La Gauchada</span> 🥟</h1><div class="nav"><a href="/escanear" class="btn-primary">📷 Escanear QR</a><a href="/qr" target="_blank" class="btn-secondary">🔗 Mostrar QR</a><a href="/logout" class="btn-secondary" style="color:var(--danger)">Salir</a></div></header><div class="table-container"><table><thead><tr><th>ID</th><th>Nombre</th><th>Teléfono</th><th>Progreso / Premios</th><th>Acciones</th></tr></thead><tbody>${lista || '<tr><td colspan="5"><div class="empty-state"><div class="empty-state-icon">👥</div><h3>No hay clientes registrados</h3><p style="margin-top:8px;font-size:14px;">Los clientes aparecerán aquí una vez que se unan al Club.</p></div></td></tr>'}</tbody></table></div></div></body></html>`);
});

app.get('/editar/:id', requireAuth, async (req, res) => {
  const cliente = await obtenerCliente(req.params.id);
  if (!cliente) return res.status(404).send('Cliente no encontrado');
  const { progreso, disponibles } = calcularPremios(cliente);
  res.send(`<!DOCTYPE html><html lang="es"><head>${UI.head('Editar Cliente')}<style>.info-box { background: #f0f9ff; border: 1px solid rgba(14, 165, 233, 0.2); border-radius: 16px; padding: 16px; margin: 20px 0; text-align: left; font-size: 14px; line-height: 1.5; } .info-box h4 { color: #0369a1; font-weight: 700; margin-bottom: 4px; } .info-box p { color: #0e7490; } .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; } .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 28px; }</style></head><body><div class="card"><div class="logo"><span>LA GAUCHADA</span></div><div class="subtitle">Editar Cliente #${cliente.id}</div><form action="/editar/${cliente.id}" method="POST"><div class="form-group"><label>Nombre del cliente</label><input type="text" name="nombre" value="${cliente.nombre}" required maxlength="100"></div><div class="form-group"><label>Teléfono</label><input type="tel" name="telefono" value="${cliente.telefono || ''}" maxlength="20"></div><div class="info-box"><h4>Resumen de Puntos</h4><p>Sellos totales acumulados: <strong>${cliente.sellos_totales || 0}</strong></p><p>Progreso actual: <strong>${progreso}/10</strong></p><p>Empanadas disponibles: <strong>${disponibles}</strong></p></div><div class="form-row"><div class="form-group"><label>Sellos Totales</label><input type="number" name="sellos_totales" value="${cliente.sellos_totales || 0}" min="0"></div><div class="form-group"><label>Canjeadas</label><input type="number" name="empanadas_canjeadas" value="${cliente.empanadas_canjeadas || 0}" min="0"></div></div><div class="btns"><a class="btn btn-secondary" href="/panel">Cancelar</a><button type="submit">Guardar</button></div></form></div></body></html>`);
});

app.post('/editar/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const nombre = (req.body.nombre || '').trim().slice(0, 100);
  const telefono = (req.body.telefono || '').trim().slice(0, 20);
  const sellos_totales = Math.max(0, parseInt(req.body.sellos_totales) || 0);
  const empanadas_canjeadas = Math.max(0, parseInt(req.body.empanadas_canjeadas) || 0);
  await editarCliente(id, nombre, telefono, sellos_totales, empanadas_canjeadas);
  const cliente = await obtenerCliente(id);
  try { await actualizarWallet(cliente); } catch (err) { /* ya logueado en actualizarWallet */ }
  res.redirect('/panel');
});

app.post('/eliminar/:id', requireAuth, async (req, res) => {
  await eliminarCliente(req.params.id);
  res.redirect('/panel');
});

app.post('/canjear', requireAuth, async (req, res) => {
  const { id } = req.body;
  const cliente = await obtenerCliente(id);
  if (!cliente) return res.status(404).send('Cliente no encontrado');
  const { disponibles, pendientes } = calcularPremios(cliente);
  if (disponibles < 1) return res.status(400).send('No hay empanadas disponibles');
  await canjearEmpanada(id);
  const clienteActualizado = await obtenerCliente(id);
  try { await actualizarWallet(clienteActualizado); } catch (err) { /* ya logueado en actualizarWallet */ }
  const restantes = pendientes - 1;
  res.send(`<!DOCTYPE html><html lang="es"><head>${UI.head('Canje Exitoso')}<style>.success-icon { font-size: 56px; margin-bottom: 20px; } h1 { font-size: 26px; color: var(--success); margin-bottom: 12px; font-weight: 800; } .client-details { background: #f8fafc; border: 1px solid var(--border); border-radius: 16px; padding: 16px; margin: 24px 0; font-size: 15px; } .pill { display: inline-block; padding: 8px 16px; border-radius: 9999px; background: var(--primary-light); color: var(--primary-dark); font-weight: 700; margin-top: 12px; font-size: 14px; }</style></head><body><div class="card"><div class="success-icon">🥟🎉</div><h1>¡Canje Exitoso!</h1><p>Se ha procesado correctamente la entrega del premio.</p><div class="client-details"><p>Cliente: <strong>${cliente.nombre}</strong></p><div class="pill">${restantes > 0 ? `Le quedan ${restantes} empanada${restantes > 1 ? 's' : ''} gratis` : 'No quedan premios pendientes'}</div></div><a class="btn" href="/panel">← Volver al panel</a></div></body></html>`);
});

app.get('/qr', async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/registro`;
  const qr = await QRCode.toDataURL(url, { width: 400, margin: 2 });
  res.send(`<!DOCTYPE html><html lang="es"><head>${UI.head('QR Registro')}<style>.qr-container { background: white; border-radius: 20px; padding: 24px; box-shadow: var(--shadow-md); margin: 24px 0; display: inline-block; border: 1px solid var(--border); } img { max-width: 100%; height: auto; display: block; } .instructions { font-size: 14px; color: var(--text-muted); font-weight: 500; }</style></head><body><div class="card"><div class="logo"><span>LA GAUCHADA</span> 🥟</div><div class="subtitle">Club de Lealtad</div><p style="font-size: 15px; font-weight: 500;">Escaneá el código QR con tu celular para registrarte y obtener premios.</p><div class="qr-container"><img src="${qr}" alt="Código QR de registro"></div><div class="instructions">📱 Abrí la cámara de tu celular y enfocá aquí</div></div></body></html>`);
});

app.get('/escanear', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Escanear Cliente | La Gauchada</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet"><style>:root { --primary: #0ea5e9; --primary-dark: #0284c7; --primary-light: rgba(14, 165, 233, 0.15); --bg: #0f172a; --card-bg: #ffffff; --text: #0f172a; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --warning: #f59e0b; --danger: #ef4444; --shadow-lg: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1); } * { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: 'Inter', -apple-system, sans-serif; background: radial-gradient(circle at top, #1e1b4b 0%, #0f172a 100%); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; } .card { background: var(--card-bg); border-radius: 24px; padding: 32px 24px; max-width: 440px; width: 100%; box-shadow: var(--shadow-lg); text-align: center; border: 1px solid rgba(255, 255, 255, 0.8); } h2 { font-size: 24px; font-weight: 800; color: var(--primary); margin-bottom: 6px; } .subtitle { color: var(--text-muted); font-size: 14px; margin-bottom: 20px; } #reader { width: 100%; border-radius: 16px; overflow: hidden; border: 2px solid var(--border); background: #f8fafc; margin-bottom: 16px; } #reader video { border-radius: 14px; } #confirmar { display: none; margin-top: 16px; text-align: left; } .client-details { background: #f0f9ff; border: 1px solid rgba(14, 165, 233, 0.2); border-radius: 16px; padding: 16px; margin-bottom: 20px; } .client-details .nombre { font-size: 18px; font-weight: 700; color: #0369a1; margin-bottom: 4px; } .client-details .info { font-size: 13px; color: #0c4a6e; font-weight: 500; } .form-group { margin-bottom: 20px; } label { display: block; font-size: 14px; font-weight: 600; color: #334155; margin-bottom: 8px; } #cantidad { width: 100%; padding: 14px; font-size: 20px; font-weight: 700; text-align: center; border: 2px solid var(--border); border-radius: 14px; outline: none; background: #f8fafc; transition: all 0.2s ease; } #cantidad:focus { border-color: var(--primary); background: white; box-shadow: 0 0 0 4px var(--primary-light); } .btns { display: grid; grid-template-columns: 1fr 1.2fr; gap: 10px; margin-top: 20px; } button { padding: 14px; border: none; border-radius: 14px; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.2s ease; font-family: inherit; } .btn-confirmar { background: var(--primary); color: white; box-shadow: 0 4px 10px rgba(14, 165, 233, 0.2); } .btn-confirmar:hover { background: var(--primary-dark); transform: translateY(-2px); } .btn-cancelar { background: #f1f5f9; color: #475569; } .btn-cancelar:hover { background: #e2e8f0; color: #1e293b; } #resultado { margin-top: 16px; padding: 16px; border-radius: 16px; font-size: 15px; font-weight: 600; display: none; text-align: center; line-height: 1.4; } #resultado.ok { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; } #resultado.error { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; } #resultado.premio { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; font-weight: 700; }
#resultado.warn { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; text-align: left; font-weight: 600; } .volver { display: inline-block; margin-top: 24px; color: var(--primary); font-size: 14px; text-decoration: none; font-weight: 600; transition: color 0.2s ease; } .volver:hover { color: var(--primary-dark); }</style></head><body><div class="card"><h2>Escanear QR</h2><p class="subtitle" id="instruccion">Apuntá la cámara al código QR del cliente</p><div id="reader"></div><div id="confirmar"><div class="client-details"><div class="nombre" id="cliente-nombre"></div><div class="info" id="cliente-info"></div></div><div class="form-group"><label for="cantidad">¿Cuántas empanadas compró?</label><input type="number" id="cantidad" min="1" value="1"></div><div class="btns"><button class="btn-cancelar" id="btn-cancelar">Cancelar</button><button class="btn-confirmar" id="btn-confirmar">Sumar Sellos</button></div></div><div id="resultado"></div><a class="volver" href="/panel">← Volver al panel</a></div><script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script><script>
    let escaneando=true,clienteId=null;
    const resultado=document.getElementById('resultado'),confirmar=document.getElementById('confirmar'),instruccion=document.getElementById('instruccion');
    const scanner=new Html5Qrcode('reader');
    function iniciarScanner(){
      escaneando=true;clienteId=null;
      confirmar.style.display='none';resultado.style.display='none';
      instruccion.textContent='Apuntá la cámara al código QR del cliente';
      document.getElementById('cantidad').value=1;
      scanner.start({facingMode:'environment'},{fps:10,qrbox:{width:250,height:250}},async(texto)=>{
        if(!escaneando)return;escaneando=false;scanner.stop();
        try{
          const res=await fetch('/api/cliente/'+texto);
          const data=await res.json();
          if(res.ok){
            clienteId=texto;
            document.getElementById('cliente-nombre').textContent=data.nombre;
            document.getElementById('cliente-info').textContent='Progreso actual: '+data.progreso+'/10'+(data.disponibles>0?' · 🥟×'+data.disponibles+' empanada(s) gratis':'');
            instruccion.textContent='';confirmar.style.display='block';
          }else{resultado.style.display='block';resultado.className='error';resultado.textContent='✗ Cliente no encontrado';setTimeout(iniciarScanner,2500);}
        }catch(e){resultado.style.display='block';resultado.className='error';resultado.textContent='✗ Error de conexión';setTimeout(iniciarScanner,2500);}
      },()=>{});
    }
    document.getElementById('btn-cancelar').addEventListener('click',iniciarScanner);
    document.getElementById('btn-confirmar').addEventListener('click',async()=>{
      const cantidad=parseInt(document.getElementById('cantidad').value)||1;
      confirmar.style.display='none';resultado.style.display='block';resultado.className='';resultado.textContent='Registrando sellos...';
      try{
        const res=await fetch('/api/sello/'+clienteId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cantidad})});
        const data=await res.json();
        if(res.ok){
          if(data.disponibles>0){resultado.className='premio';resultado.innerHTML='🥟 ¡'+data.disponibles+' empanada'+(data.disponibles>1?'s':'')+' de regalo disponible'+(data.disponibles>1?'s':'')+' para '+data.nombre+'!';}
          else{resultado.className='ok';resultado.textContent='✓ '+cantidad+' sello(s) agregado(s) a '+data.nombre+' ('+data.progreso+'/10)';}
          if(data.walletSync===false){resultado.className='warn';resultado.textContent+=' ⚠️ Los sellos se guardaron, pero la tarjeta de Wallet NO se actualizó. Revisá los registros del servidor.';}
        }else{resultado.className='error';resultado.textContent='✗ '+(data.error||'Error al agregar sellos');}
      }catch(e){resultado.className='error';resultado.textContent='✗ Error de conexión';}
      setTimeout(iniciarScanner,resultado.className==='warn'?8000:3500);
    });
    iniciarScanner();
  </script></body></html>`);
});

app.get('/api/cliente/:id', requireAuth, async (req, res) => {
  const cliente = await obtenerCliente(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  const { progreso, disponibles } = calcularPremios(cliente);
  res.json({ nombre: cliente.nombre, progreso, disponibles });
});

app.post('/api/sello/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const cantidad = Math.max(1, parseInt(req.body.cantidad) || 1);
  const cliente = await obtenerCliente(id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
  await agregarSellos(id, cantidad);
  const clienteActualizado = await obtenerCliente(id);
  const { progreso, disponibles } = calcularPremios(clienteActualizado);
  let walletSync = true;
  try { walletSync = await actualizarWallet(clienteActualizado); } catch (err) { walletSync = false; }
  res.json({ nombre: cliente.nombre, progreso, disponibles, walletSync });
});

inicializarDB()
  .then(() => {
    app.listen(process.env.PORT || 3000, () => {
      console.log(`✅ Servidor corriendo en http://localhost:${process.env.PORT || 3000}`);
      console.log(`   Registro:  http://localhost:3000/registro`);
      console.log(`   Panel:     http://localhost:3000/panel`);
      if (!PANEL_PASSWORD) console.warn('⚠️  PANEL_PASSWORD no está configurada: el acceso al panel y al escáner queda bloqueado.');
      console.log(`   QR:        http://localhost:3000/qr`);
    });
  })
  .catch(err => { console.error('❌ Error conectando a la base de datos:', err); process.exit(1); });
