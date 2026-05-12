require('dotenv').config();
const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { createClient } = require('@libsql/client');
const cookieSession = require('cookie-session');

const app = express();
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
const CLASS_ID = process.env.CLASS_ID;

// ── Base de datos Turso ────────────────────────────────────
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

async function inicializarDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS clientes (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      telefono TEXT DEFAULT '',
      sellos INTEGER DEFAULT 0,
      creado_en TEXT DEFAULT (datetime('now'))
    )
  `);
}

async function obtenerCliente(id) {
  const result = await db.execute({
    sql: 'SELECT * FROM clientes WHERE id = ?',
    args: [id],
  });
  return result.rows[0] || null;
}

async function crearCliente(cliente) {
  await db.execute({
    sql: 'INSERT INTO clientes (id, nombre, telefono, sellos) VALUES (?, ?, ?, ?)',
    args: [cliente.id, cliente.nombre, cliente.telefono, cliente.sellos],
  });
}

async function actualizarSellosDB(id, sellos) {
  await db.execute({
    sql: 'UPDATE clientes SET sellos = ? WHERE id = ?',
    args: [sellos, id],
  });
}

async function obtenerTodosLosClientes() {
  const result = await db.execute('SELECT * FROM clientes ORDER BY creado_en DESC');
  return result.rows;
}

// ── Credenciales Google ────────────────────────────────────
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
});

// ── Generar link de Google Wallet ──────────────────────────
async function generarWalletLink(cliente) {
  const objectId = `${ISSUER_ID}.cliente_${cliente.id}`;

  const client = await auth.getClient();
  const loyaltyObject = {
    id: objectId,
    classId: CLASS_ID,
    state: 'ACTIVE',
    accountId: String(cliente.id),
    accountName: cliente.nombre,
    loyaltyPoints: {
      balance: { int: cliente.sellos },
      label: 'Sellos',
    },
    textModulesData: [
      {
        header: 'Próxima recompensa',
        body: cliente.sellos >= 10
          ? '¡Empanada gratis disponible! 🎉'
          : `${10 - cliente.sellos} sellos más para tu empanada gratis`,
        id: 'next_reward',
      },
    ],
    barcode: {
      type: 'QR_CODE',
      value: String(cliente.id),
      alternateText: `#${cliente.id}`,
    },
  };

  try {
    await client.request({
      url: `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject`,
      method: 'POST',
      data: loyaltyObject,
    });
  } catch (err) {
    if (err.response?.status !== 409) throw err;
  }

  const claims = {
    iss: credentials.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: {
      loyaltyObjects: [{ id: objectId }],
    },
  };

  const token = jwt.sign(claims, credentials.private_key, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}

// ── Actualizar sellos en Google Wallet ─────────────────────
async function actualizarSellosWallet(cliente) {
  const client = await auth.getClient();
  const objectId = `${ISSUER_ID}.cliente_${cliente.id}`;

  await client.request({
    url: `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${encodeURIComponent(objectId)}`,
    method: 'PATCH',
    data: {
      loyaltyPoints: {
        balance: { int: cliente.sellos },
        label: 'Sellos',
      },
      textModulesData: [
        {
          header: 'Próxima recompensa',
          body: cliente.sellos >= 10
            ? '¡Empanada gratis disponible! 🎉'
            : `${10 - cliente.sellos} sellos más para tu empanada gratis`,
          id: 'next_reward',
        },
      ],
    },
  });
}

// ── RUTAS ──────────────────────────────────────────────────

app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Acceso Panel</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, sans-serif; background: #00ADEF; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .card { background: white; border-radius: 20px; padding: 32px 24px; max-width: 360px; width: 100%; text-align: center; }
        .logo { font-size: 24px; font-weight: 800; color: #00ADEF; margin-bottom: 4px; }
        .subtitle { color: #666; font-size: 14px; margin-bottom: 28px; }
        input { width: 100%; padding: 14px 16px; border: 2px solid #e0e0e0; border-radius: 12px; font-size: 16px; margin-bottom: 12px; outline: none; transition: border-color 0.2s; }
        input:focus { border-color: #00ADEF; }
        button { width: 100%; padding: 16px; background: #00ADEF; color: white; border: none; border-radius: 12px; font-size: 17px; font-weight: 600; cursor: pointer; }
        .error { color: #e53e3e; font-size: 14px; margin-bottom: 12px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">LA GAUCHADA</div>
        <div class="subtitle">Acceso al panel</div>
        ${req.query.error ? '<div class="error">Contraseña incorrecta</div>' : ''}
        <form action="/login" method="POST">
          <input type="password" name="password" placeholder="Contraseña" required autofocus>
          <button type="submit">Entrar →</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.PANEL_PASSWORD) {
    req.session.autenticado = true;
    res.redirect('/panel');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

app.get('/registro', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Club La Gauchada</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, sans-serif; background: #00ADEF; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .card { background: white; border-radius: 20px; padding: 32px 24px; max-width: 400px; width: 100%; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.15); }
        .logo { font-size: 28px; font-weight: 800; color: #00ADEF; margin-bottom: 4px; letter-spacing: -0.5px; }
        .subtitle { color: #666; font-size: 15px; margin-bottom: 28px; }
        .promo { background: #f0f9ff; border-radius: 12px; padding: 16px; margin-bottom: 24px; }
        .promo p { color: #00ADEF; font-weight: 600; font-size: 15px; }
        input { width: 100%; padding: 14px 16px; border: 2px solid #e0e0e0; border-radius: 12px; font-size: 16px; margin-bottom: 12px; outline: none; transition: border-color 0.2s; }
        input:focus { border-color: #00ADEF; }
        button { width: 100%; padding: 16px; background: #00ADEF; color: white; border: none; border-radius: 12px; font-size: 17px; font-weight: 600; cursor: pointer; }
        button:active { opacity: 0.9; }
        .footer { margin-top: 20px; font-size: 13px; color: #999; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">LA GAUCHADA</div>
        <div class="subtitle">Club de Lealtad</div>
        <div class="promo">
          <p>☕ Acumulá 10 sellos y ganás una empanada gratis</p>
        </div>
        <form action="/registro" method="POST">
          <input type="text" name="nombre" placeholder="Tu nombre" required maxlength="100">
          <input type="tel" name="telefono" placeholder="Tu teléfono (opcional)" maxlength="20">
          <button type="submit">Unirme al club →</button>
        </form>
        <div class="footer">Tu tarjeta se agrega directo a Google Wallet</div>
      </div>
    </body>
    </html>
  `);
});

app.post('/registro', async (req, res) => {
  const nombre = (req.body.nombre || '').trim().slice(0, 100);
  const telefono = (req.body.telefono || '').trim().slice(0, 20);

  if (!nombre) return res.status(400).send('El nombre es requerido.');

  const id = Date.now().toString(36).slice(-6).toUpperCase();
  const cliente = { id, nombre, telefono, sellos: 0 };

  try {
    await crearCliente(cliente);
    const walletLink = await generarWalletLink(cliente);

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>¡Bienvenido!</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, sans-serif; background: #00ADEF; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
          .card { background: white; border-radius: 20px; padding: 32px 24px; max-width: 400px; width: 100%; text-align: center; }
          h1 { font-size: 24px; color: #333; margin-bottom: 8px; }
          p { color: #666; margin-bottom: 24px; font-size: 15px; }
          .wallet-btn { display: block; background: #000; color: white; padding: 16px; border-radius: 12px; text-decoration: none; font-size: 17px; font-weight: 600; margin-bottom: 12px; }
          .id { background: #f5f5f5; border-radius: 8px; padding: 12px; font-size: 13px; color: #999; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>¡Bienvenido, ${nombre}! 🎉</h1>
          <p>Tu tarjeta de sellos está lista. Agregala a Google Wallet con un toque.</p>
          <a class="wallet-btn" href="${walletLink}">+ Agregar a Google Wallet</a>
          <div class="id">Tu número de cliente: #${id}</div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al crear la tarjeta. Intentá de nuevo.');
  }
});

app.get('/panel', requireAuth, async (req, res) => {
  const clientes = await obtenerTodosLosClientes();

  const lista = clientes.map(c => `
    <tr>
      <td>#${c.id}</td>
      <td>${c.nombre}</td>
      <td>${c.telefono || '-'}</td>
      <td><strong>${c.sellos}/10</strong></td>
      <td>
        <form action="/sello" method="POST" style="display:inline">
          <input type="hidden" name="id" value="${c.id}">
          <button type="submit">+ Sello</button>
        </form>
        ${c.sellos >= 10 ? `
        <form action="/canjear" method="POST" style="display:inline">
          <input type="hidden" name="id" value="${c.id}">
          <button type="submit" style="background:#22c55e">🎁 Canjear</button>
        </form>` : ''}
      </td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Panel La Gauchada</title>
      <style>
        body { font-family: -apple-system, sans-serif; padding: 24px; background: #f5f5f5; }
        h1 { color: #00ADEF; margin-bottom: 20px; }
        table { width: 100%; background: white; border-radius: 12px; border-collapse: collapse; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
        th { background: #00ADEF; color: white; padding: 12px 16px; text-align: left; font-size: 14px; }
        td { padding: 12px 16px; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
        button { padding: 8px 14px; background: #00ADEF; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; margin-right: 6px; }
        .empty { text-align: center; padding: 40px; color: #999; }
      </style>
    </head>
    <body>
      <h1>Panel La Gauchada ☕</h1>
      <table>
        <thead>
          <tr><th>#</th><th>Nombre</th><th>Teléfono</th><th>Sellos</th><th>Acción</th></tr>
        </thead>
        <tbody>
          ${lista || '<tr><td colspan="5" class="empty">No hay clientes registrados aún</td></tr>'}
        </tbody>
      </table>
    </body>
    </html>
  `);
});

app.post('/sello', requireAuth, async (req, res) => {
  const { id } = req.body;
  const cliente = await obtenerCliente(id);
  if (!cliente) return res.status(404).send('Cliente no encontrado');

  const nuevosSellos = Math.min(Number(cliente.sellos) + 1, 10);
  await actualizarSellosDB(id, nuevosSellos);

  try {
    await actualizarSellosWallet({ ...cliente, sellos: nuevosSellos });
  } catch (err) {
    console.error('Error actualizando wallet:', err.message);
  }

  res.redirect('/panel');
});

app.post('/canjear', requireAuth, async (req, res) => {
  const { id } = req.body;
  const cliente = await obtenerCliente(id);
  if (!cliente) return res.status(404).send('Cliente no encontrado');

  await actualizarSellosDB(id, 0);

  try {
    await actualizarSellosWallet({ ...cliente, sellos: 0 });
  } catch (err) {
    console.error('Error actualizando wallet:', err.message);
  }

  res.redirect('/panel');
});

app.get('/qr', async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/registro`;
  const qr = await QRCode.toDataURL(url, { width: 400, margin: 2 });
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>QR La Gauchada</title>
      <style>
        body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: white; }
        .wrap { text-align: center; padding: 40px; border: 3px solid #00ADEF; border-radius: 20px; max-width: 350px; }
        h2 { color: #00ADEF; font-size: 22px; margin-bottom: 4px; }
        p { color: #666; font-size: 14px; margin-bottom: 20px; }
        img { width: 250px; height: 250px; }
        .inst { margin-top: 16px; font-size: 13px; color: #999; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <h2>LA GAUCHADA</h2>
        <p>Escaneá para unirte al club de lealtad</p>
        <img src="${qr}" alt="QR">
        <div class="inst">📱 Abrí la cámara y apuntá acá</div>
      </div>
    </body>
    </html>
  `);
});

// ── Escanear QR del cliente ────────────────────────────────
app.get('/escanear', requireAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Escanear Cliente</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, sans-serif; background: #00ADEF; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
        .card { background: white; border-radius: 20px; padding: 24px; max-width: 400px; width: 100%; text-align: center; }
        h2 { color: #00ADEF; font-size: 20px; margin-bottom: 6px; }
        p { color: #666; font-size: 14px; margin-bottom: 20px; }
        #reader { width: 100%; border-radius: 12px; overflow: hidden; }
        #resultado { margin-top: 16px; padding: 14px; border-radius: 12px; font-size: 15px; display: none; }
        #resultado.ok { background: #dcfce7; color: #166534; }
        #resultado.error { background: #fee2e2; color: #991b1b; }
        .volver { display: block; margin-top: 16px; color: #00ADEF; font-size: 14px; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Escanear cliente</h2>
        <p>Apuntá la cámara al QR del cliente</p>
        <div id="reader"></div>
        <div id="resultado"></div>
        <a class="volver" href="/panel">← Volver al panel</a>
      </div>
      <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
      <script>
        let escaneando = true;
        const resultado = document.getElementById('resultado');

        const scanner = new Html5Qrcode('reader');
        scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          async (texto) => {
            if (!escaneando) return;
            escaneando = false;
            scanner.stop();

            resultado.style.display = 'block';
            resultado.className = '';
            resultado.textContent = 'Agregando sello...';

            try {
              const res = await fetch('/api/sello/' + texto, { method: 'POST' });
              const data = await res.json();
              if (res.ok) {
                resultado.className = 'ok';
                resultado.textContent = '✓ Sello agregado a ' + data.nombre + ' (' + data.sellos + '/10)';
                setTimeout(() => {
                  escaneando = true;
                  resultado.style.display = 'none';
                  scanner.start(
                    { facingMode: 'environment' },
                    { fps: 10, qrbox: { width: 250, height: 250 } },
                    arguments.callee,
                    () => {}
                  );
                }, 2500);
              } else {
                resultado.className = 'error';
                resultado.textContent = '✗ ' + (data.error || 'Cliente no encontrado');
                setTimeout(() => { escaneando = true; resultado.style.display = 'none'; }, 2500);
              }
            } catch (e) {
              resultado.className = 'error';
              resultado.textContent = '✗ Error de conexión';
              setTimeout(() => { escaneando = true; resultado.style.display = 'none'; }, 2500);
            }
          },
          () => {}
        );
      </script>
    </body>
    </html>
  `);
});

app.get('/api/cliente/:id', requireAuth, async (req, res) => {   const cliente = await obtenerCliente(req.params.id);   if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });   res.json({ nombre: cliente.nombre, sellos: cliente.sellos }); });  app.post('/api/sello/:id', requireAuth, async (req, res) => {   const { id } = req.params;   const cantidad = Math.max(1, Math.min(10, parseInt(req.body.cantidad) || 1));   const cliente = await obtenerCliente(id);   if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });    const nuevosSellos = Math.min(Number(cliente.sellos) + cantidad, 10);   await actualizarSellosDB(id, nuevosSellos);    try {     await actualizarSellosWallet({ ...cliente, sellos: nuevosSellos });   } catch (err) {     console.error('Error actualizando wallet:', err.message);   }    res.json({ nombre: cliente.nombre, sellos: nuevosSellos }); });
  const { id } = req.params;
  const cliente = await obtenerCliente(id);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

  const nuevosSellos = Math.min(Number(cliente.sellos) + 1, 10);
  await actualizarSellosDB(id, nuevosSellos);

  try {
    await actualizarSellosWallet({ ...cliente, sellos: nuevosSellos });
  } catch (err) {
    console.error('Error actualizando wallet:', err.message);
  }

  res.json({ nombre: cliente.nombre, sellos: nuevosSellos });
});

// ── Arranque ───────────────────────────────────────────────
inicializarDB()
  .then(() => {
    app.listen(process.env.PORT || 3000, () => {
      console.log(`✅ Servidor corriendo en http://localhost:${process.env.PORT || 3000}`);
      console.log(`   Registro:  http://localhost:3000/registro`);
      console.log(`   Panel:     http://localhost:3000/panel`);
      console.log(`   QR:        http://localhost:3000/qr`);
    });
  })
  .catch(err => {
    console.error('❌ Error conectando a la base de datos:', err);
    process.exit(1);
  });
