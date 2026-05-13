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

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'] });

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

async function actualizarWallet(cliente) {
  const client = await auth.getClient();
  const objectId = `${ISSUER_ID}.cliente_${cliente.id}`;
  const { progreso } = calcularPremios(cliente);
  await client.request({
    url: `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${encodeURIComponent(objectId)}`,
    method: 'PATCH',
    data: {
      loyaltyPoints: { balance: { int: progreso }, label: 'Sellos' },
      textModulesData: [{ header: 'Premio', body: walletBody(cliente), id: 'next_reward' }],
    },
  });
}

// ── RUTAS ──────────────────────────────────────────────────

app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Acceso Panel</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#00ADEF;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:white;border-radius:20px;padding:32px 24px;max-width:360px;width:100%;text-align:center}.logo{font-size:24px;font-weight:800;color:#00ADEF;margin-bottom:4px}.subtitle{color:#666;font-size:14px;margin-bottom:28px}input{width:100%;padding:14px 16px;border:2px solid #e0e0e0;border-radius:12px;font-size:16px;margin-bottom:12px;outline:none}input:focus{border-color:#00ADEF}button{width:100%;padding:16px;background:#00ADEF;color:white;border:none;border-radius:12px;font-size:17px;font-weight:600;cursor:pointer}.error{color:#e53e3e;font-size:14px;margin-bottom:12px}</style></head><body><div class="card"><div class="logo">LA GAUCHADA</div><div class="subtitle">Acceso al panel</div>${req.query.error ? '<div class="error">Contraseña incorrecta</div>' : ''}<form action="/login" method="POST"><input type="password" name="password" placeholder="Contraseña" required autofocus><button type="submit">Entrar →</button></form></div></body></html>`);
});

app.post('/login', (req, res) => {
  if (req.body.password === process.env.PANEL_PASSWORD) { req.session.autenticado = true; res.redirect('/panel'); }
  else res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

app.get('/registro', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Club La Gauchada</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#00ADEF;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:white;border-radius:20px;padding:32px 24px;max-width:400px;width:100%;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.15)}.logo{font-size:28px;font-weight:800;color:#00ADEF;margin-bottom:4px;letter-spacing:-0.5px}.subtitle{color:#666;font-size:15px;margin-bottom:28px}.promo{background:#f0f9ff;border-radius:12px;padding:16px;margin-bottom:24px}.promo p{color:#00ADEF;font-weight:600;font-size:15px}input{width:100%;padding:14px 16px;border:2px solid #e0e0e0;border-radius:12px;font-size:16px;margin-bottom:12px;outline:none}input:focus{border-color:#00ADEF}button{width:100%;padding:16px;background:#00ADEF;color:white;border:none;border-radius:12px;font-size:17px;font-weight:600;cursor:pointer}.footer{margin-top:20px;font-size:13px;color:#999}</style></head><body><div class="card"><div class="logo">LA GAUCHADA</div><div class="subtitle">Club de Lealtad</div><div class="promo"><p>🥟 Acumulá 10 sellos y ganás una empanada gratis</p></div><form action="/registro" method="POST"><input type="text" name="nombre" placeholder="Tu nombre" required maxlength="100"><input type="tel" name="telefono" placeholder="Tu teléfono (opcional)" maxlength="20"><button type="submit">Unirme al club →</button></form><div class="footer">Tu tarjeta se agrega directo a Google Wallet</div></div></body></html>`);
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
    res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>¡Bienvenido!</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#00ADEF;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:white;border-radius:20px;padding:32px 24px;max-width:400px;width:100%;text-align:center}h1{font-size:24px;color:#333;margin-bottom:8px}p{color:#666;margin-bottom:24px;font-size:15px}.wallet-btn{display:block;background:#000;color:white;padding:16px;border-radius:12px;text-decoration:none;font-size:17px;font-weight:600;margin-bottom:12px}.id{background:#f5f5f5;border-radius:8px;padding:12px;font-size:13px;color:#999}</style></head><body><div class="card"><h1>¡Bienvenido, ${nombre}! 🎉</h1><p>Tu tarjeta de sellos está lista. Agregala a Google Wallet con un toque.</p><a class="wallet-btn" href="${walletLink}">+ Agregar a Google Wallet</a><div class="id">Tu número de cliente: #${id}</div></div></body></html>`);
  } catch (err) { console.error(err); res.status(500).send('Error al crear la tarjeta. Intentá de nuevo.'); }
});

app.get('/panel', requireAuth, async (req, res) => {
  const clientes = await obtenerTodosLosClientes();
  const lista = clientes.map(c => {
    const { progreso, disponibles, pendientes } = calcularPremios(c);
    return `<tr>
      <td>#${c.id}</td><td>${c.nombre}</td><td>${c.telefono || '-'}</td>
      <td><strong>${progreso}/10</strong>${disponibles > 0 ? ` <span style="color:#22c55e">🥟×${disponibles}</span>` : ''}${pendientes > 3 ? ` <span style="color:#f59e0b;font-size:12px">(+${pendientes-3} espera)</span>` : ''}</td>
      <td>
        ${disponibles > 0 ? `<form action="/canjear" method="POST" style="display:inline"><input type="hidden" name="id" value="${c.id}"><button type="submit" style="background:#22c55e">🎁 Canjear</button></form>` : ''}
        <a href="/editar/${c.id}" style="display:inline-block;padding:8px 12px;background:#f5f5f5;color:#333;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;margin:0 4px">✏️</a>
        <form action="/eliminar/${c.id}" method="POST" style="display:inline" onsubmit="return confirm('¿Eliminar a ${c.nombre}?')"><button type="submit" style="background:#ef4444">🗑️</button></form>
      </td></tr>`;
  }).join('');
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Panel La Gauchada</title><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#00ADEF"><meta name="mobile-web-app-capable" content="yes"><style>body{font-family:-apple-system,sans-serif;padding:24px;background:#f5f5f5}h1{color:#00ADEF;margin-bottom:16px}.nav{margin-bottom:16px}.nav a{display:inline-block;padding:10px 18px;background:#00ADEF;color:white;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;margin-right:8px}table{width:100%;background:white;border-radius:12px;border-collapse:collapse;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08)}th{background:#00ADEF;color:white;padding:12px 16px;text-align:left;font-size:14px}td{padding:12px 16px;border-bottom:1px solid #f0f0f0;font-size:14px}button{padding:8px 12px;background:#00ADEF;color:white;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;margin-right:4px}.empty{text-align:center;padding:40px;color:#999}</style></head><body><h1>Panel La Gauchada 🥟</h1><div class="nav"><a href="/escanear">📷 Escanear</a><a href="/logout" style="background:#666">Salir</a></div><table><thead><tr><th>#</th><th>Nombre</th><th>Teléfono</th><th>Sellos/Premios</th><th>Acciones</th></tr></thead><tbody>${lista || '<tr><td colspan="5" class="empty">No hay clientes registrados aún</td></tr>'}</tbody></table></body></html>`);
});

app.get('/editar/:id', requireAuth, async (req, res) => {
  const cliente = await obtenerCliente(req.params.id);
  if (!cliente) return res.status(404).send('Cliente no encontrado');
  const { progreso, disponibles } = calcularPremios(cliente);
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Editar Cliente</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#00ADEF;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:white;border-radius:20px;padding:32px 24px;max-width:400px;width:100%}h2{color:#00ADEF;margin-bottom:20px;text-align:center}label{display:block;font-size:13px;color:#666;margin-bottom:4px;margin-top:14px}input{width:100%;padding:12px 16px;border:2px solid #e0e0e0;border-radius:12px;font-size:16px;outline:none}input:focus{border-color:#00ADEF}.info{background:#f0f9ff;border-radius:10px;padding:12px;margin:16px 0;font-size:13px;color:#555}.btns{display:flex;gap:10px;margin-top:20px}.btn-save{flex:1;padding:14px;background:#00ADEF;color:white;border:none;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer}.btn-back{flex:1;padding:14px;background:#f5f5f5;color:#666;border:none;border-radius:12px;font-size:16px;text-decoration:none;text-align:center}</style></head><body><div class="card"><h2>Editar #${cliente.id}</h2><form action="/editar/${cliente.id}" method="POST"><label>Nombre</label><input type="text" name="nombre" value="${cliente.nombre}" required maxlength="100"><label>Teléfono</label><input type="tel" name="telefono" value="${cliente.telefono || ''}" maxlength="20"><div class="info">Sellos totales: ${cliente.sellos_totales || 0} · Progreso: ${progreso}/10 · Empanadas disponibles: ${disponibles}</div><label>Corregir sellos totales</label><input type="number" name="sellos_totales" value="${cliente.sellos_totales || 0}" min="0"><label>Empanadas ya canjeadas</label><input type="number" name="empanadas_canjeadas" value="${cliente.empanadas_canjeadas || 0}" min="0"><div class="btns"><a class="btn-back" href="/panel">Cancelar</a><button class="btn-save" type="submit">Guardar</button></div></form></div></body></html>`);
});

app.post('/editar/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const nombre = (req.body.nombre || '').trim().slice(0, 100);
  const telefono = (req.body.telefono || '').trim().slice(0, 20);
  const sellos_totales = Math.max(0, parseInt(req.body.sellos_totales) || 0);
  const empanadas_canjeadas = Math.max(0, parseInt(req.body.empanadas_canjeadas) || 0);
  await editarCliente(id, nombre, telefono, sellos_totales, empanadas_canjeadas);
  const cliente = await obtenerCliente(id);
  try { await actualizarWallet(cliente); } catch (err) { console.error('Error wallet:', err.message); }
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
  try { await actualizarWallet(clienteActualizado); } catch (err) { console.error('Error wallet:', err.message); }
  const restantes = pendientes - 1;
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Canje exitoso</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#00ADEF;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:white;border-radius:20px;padding:32px 24px;max-width:400px;width:100%;text-align:center}h1{font-size:24px;color:#22c55e;margin-bottom:12px}p{color:#555;font-size:15px;margin-bottom:8px}.restante{background:#f0f9ff;border-radius:12px;padding:14px;margin:20px 0;color:#00ADEF;font-weight:600;font-size:15px}a{display:block;padding:14px;background:#00ADEF;color:white;border-radius:12px;text-decoration:none;font-size:16px;font-weight:600}</style></head><body><div class="card"><h1>🥟 ¡Canje exitoso!</h1><p><strong>${cliente.nombre}</strong> canjeó una empanada gratis.</p><div class="restante">${restantes > 0 ? `Le quedan ${restantes} empanada${restantes > 1 ? 's' : ''} por canjear` : 'No quedan empanadas pendientes'}</div><a href="/panel">← Volver al panel</a></div></body></html>`);
});

app.get('/qr', async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/registro`;
  const qr = await QRCode.toDataURL(url, { width: 400, margin: 2 });
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>QR La Gauchada</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:white}.wrap{text-align:center;padding:40px;border:3px solid #00ADEF;border-radius:20px;max-width:350px}h2{color:#00ADEF;font-size:22px;margin-bottom:4px}p{color:#666;font-size:14px;margin-bottom:20px}img{width:250px;height:250px}.inst{margin-top:16px;font-size:13px;color:#999}</style></head><body><div class="wrap"><h2>LA GAUCHADA</h2><p>Escaneá para unirte al club de lealtad</p><img src="${qr}" alt="QR"><div class="inst">📱 Abrí la cámara y apuntá acá</div></div></body></html>`);
});

app.get('/escanear', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Escanear Cliente</title> <link rel="manifest" href="/manifest.json"> <meta name="theme-color" content="#00ADEF"> <meta name="mobile-web-app-capable" content="yes"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#00ADEF;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}.card{background:white;border-radius:20px;padding:24px;max-width:400px;width:100%;text-align:center}h2{color:#00ADEF;font-size:20px;margin-bottom:6px}p{color:#666;font-size:14px;margin-bottom:20px}#reader{width:100%;border-radius:12px;overflow:hidden}#confirmar{display:none;margin-top:16px}#confirmar .nombre{font-size:18px;font-weight:600;color:#333;margin-bottom:4px}#confirmar .info{font-size:13px;color:#999;margin-bottom:16px}#confirmar label{font-size:14px;color:#555;display:block;margin-bottom:8px}#cantidad{width:80px;padding:10px;font-size:24px;text-align:center;border:2px solid #e0e0e0;border-radius:12px;outline:none}#cantidad:focus{border-color:#00ADEF}.btns{display:flex;gap:10px;margin-top:16px}.btn-confirmar{flex:1;padding:14px;background:#00ADEF;color:white;border:none;border-radius:12px;font-size:16px;font-weight:600;cursor:pointer}.btn-cancelar{flex:1;padding:14px;background:#f5f5f5;color:#666;border:none;border-radius:12px;font-size:16px;cursor:pointer}#resultado{margin-top:16px;padding:14px;border-radius:12px;font-size:15px;display:none}#resultado.ok{background:#dcfce7;color:#166534}#resultado.error{background:#fee2e2;color:#991b1b}#resultado.premio{background:#fef3c7;color:#92400e;font-weight:600}.volver{display:block;margin-top:16px;color:#00ADEF;font-size:14px;text-decoration:none}</style></head><body><div class="card"><h2>Escanear cliente</h2><p id="instruccion">Apuntá la cámara al QR del cliente</p><div id="reader"></div><div id="confirmar"><div class="nombre" id="cliente-nombre"></div><div class="info" id="cliente-info"></div><label>¿Cuántas empanadas compró?</label><input type="number" id="cantidad" min="1" value="1"><div class="btns"><button class="btn-cancelar" id="btn-cancelar">Cancelar</button><button class="btn-confirmar" id="btn-confirmar">Agregar sellos</button></div></div><div id="resultado"></div><a class="volver" href="/panel">← Volver al panel</a></div><script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script><script>
    let escaneando=true,clienteId=null;
    const resultado=document.getElementById('resultado'),confirmar=document.getElementById('confirmar'),instruccion=document.getElementById('instruccion');
    const scanner=new Html5Qrcode('reader');
    function iniciarScanner(){
      escaneando=true;clienteId=null;
      confirmar.style.display='none';resultado.style.display='none';
      instruccion.textContent='Apuntá la cámara al QR del cliente';
      document.getElementById('cantidad').value=1;
      scanner.start({facingMode:'environment'},{fps:10,qrbox:{width:250,height:250}},async(texto)=>{
        if(!escaneando)return;escaneando=false;scanner.stop();
        try{
          const res=await fetch('/api/cliente/'+texto);
          const data=await res.json();
          if(res.ok){
            clienteId=texto;
            document.getElementById('cliente-nombre').textContent=data.nombre;
            document.getElementById('cliente-info').textContent='Progreso: '+data.progreso+'/10'+(data.disponibles>0?' · 🥟×'+data.disponibles+' disponibles':'');
            instruccion.textContent='';confirmar.style.display='block';
          }else{resultado.style.display='block';resultado.className='error';resultado.textContent='✗ Cliente no encontrado';setTimeout(iniciarScanner,2500);}
        }catch(e){resultado.style.display='block';resultado.className='error';resultado.textContent='✗ Error de conexión';setTimeout(iniciarScanner,2500);}
      },()=>{});
    }
    document.getElementById('btn-cancelar').addEventListener('click',iniciarScanner);
    document.getElementById('btn-confirmar').addEventListener('click',async()=>{
      const cantidad=parseInt(document.getElementById('cantidad').value)||1;
      confirmar.style.display='none';resultado.style.display='block';resultado.className='';resultado.textContent='Agregando sellos...';
      try{
        const res=await fetch('/api/sello/'+clienteId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cantidad})});
        const data=await res.json();
        if(res.ok){
          if(data.disponibles>0){resultado.className='premio';resultado.textContent='🥟 ¡'+data.disponibles+' empanada'+(data.disponibles>1?'s':'')+' gratis disponible'+(data.disponibles>1?'s':'')+' para '+data.nombre+'!';}
          else{resultado.className='ok';resultado.textContent='✓ '+cantidad+' sello(s) agregado(s) a '+data.nombre+' ('+data.progreso+'/10)';}
        }else{resultado.className='error';resultado.textContent='✗ '+(data.error||'Error al agregar sellos');}
      }catch(e){resultado.className='error';resultado.textContent='✗ Error de conexión';}
      setTimeout(iniciarScanner,3500);
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
  try { await actualizarWallet(clienteActualizado); } catch (err) { console.error('Error wallet:', err.message); }
  res.json({ nombre: cliente.nombre, progreso, disponibles });
});

inicializarDB()
  .then(() => {
    app.listen(process.env.PORT || 3000, () => {
      console.log(`✅ Servidor corriendo en http://localhost:${process.env.PORT || 3000}`);
      console.log(`   Registro:  http://localhost:3000/registro`);
      console.log(`   Panel:     http://localhost:3000/panel`);
      console.log(`   QR:        http://localhost:3000/qr`);
    });
  })
  .catch(err => { console.error('❌ Error conectando a la base de datos:', err); process.exit(1); });
