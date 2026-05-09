require('dotenv').config();
const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const ISSUER_ID = process.env.ISSUER_ID;
const CLASS_ID = process.env.CLASS_ID;

// Base de datos simple en memoria (después migraremos a Firebase)
let clientes = {};

// Autenticación con Google
const auth = new GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
});

// ── Generar link de Google Wallet ──────────────────────────
async function generarWalletLink(cliente) {
  const credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS));
  const objectId = `${ISSUER_ID}.cliente_${cliente.id}`;

  // Crear objeto en Google Wallet
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
        body: cliente.sellos >= 10 ? '¡Empanada gratis disponible! 🎉' : `${10 - cliente.sellos} sellos más para tu empanada gratis`,
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

  // Generar JWT
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
async function actualizarSellos(cliente) {
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
          body: cliente.sellos >= 10 ? '¡Empanada gratis disponible! 🎉' : `${10 - cliente.sellos} sellos más para tu empanada gratis`,
          id: 'next_reward',
        },
      ],
    },
  });
}

// ── RUTAS ──────────────────────────────────────────────────

// Página de registro (cliente escanea el QR)
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
          <input type="text" name="nombre" placeholder="Tu nombre" required>
          <input type="tel" name="telefono" placeholder="Tu teléfono (opcional)">
          <button type="submit">Unirme al club →</button>
        </form>
        <div class="footer">Tu tarjeta se agrega directo a Google Wallet</div>
      </div>
    </body>
    </html>
  `);
});

// Procesar registro
app.post('/registro', async (req, res) => {
  const { nombre, telefono } = req.body;
  const id = Date.now().toString().slice(-6);

  const cliente = { id, nombre, telefono: telefono || '', sellos: 0 };
  clientes[id] = cliente;

  try {
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
          <a class="wallet-btn" href="${walletLink}">
            + Agregar a Google Wallet
          </a>
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

// Panel de control (para vos)
app.get('/panel', (req, res) => {
  const lista = Object.values(clientes).map(c => `
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

// Agregar sello
app.post('/sello', async (req, res) => {
  const { id } = req.body;
  if (!clientes[id]) return res.status(404).send('Cliente no encontrado');

  clientes[id].sellos = Math.min(clientes[id].sellos + 1, 10);

  try {
    await actualizarSellos(clientes[id]);
  } catch (err) {
    console.error('Error actualizando wallet:', err.message);
  }

  res.redirect('/panel');
});

// Canjear recompensa
app.post('/canjear', async (req, res) => {
  const { id } = req.body;
  if (!clientes[id]) return res.status(404).send('Cliente no encontrado');

  clientes[id].sellos = 0;

  try {
    await actualizarSellos(clientes[id]);
  } catch (err) {
    console.error('Error actualizando wallet:', err.message);
  }

  res.redirect('/panel');
});

// Generar QR para el mostrador
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

app.listen(process.env.PORT || 3000, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${process.env.PORT || 3000}`);
  console.log(`   Registro:  http://localhost:3000/registro`);
  console.log(`   Panel:     http://localhost:3000/panel`);
  console.log(`   QR:        http://localhost:3000/qr`);
});