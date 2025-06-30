// server.js
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const haversine = require('haversine-distance');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// —————————————
// 1) Conexión a MySQL
// —————————————
require('dotenv').config();       // si no lo usas aún, instala dotenv
const mysql = require('mysql2');
const DATABASE_URL = process.env.DATABASE_URL;

let db;
if (DATABASE_URL) {
  // Railway te da la URL completa
  db = mysql.createConnection(DATABASE_URL);
} else {
  // Fallback local
  db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '1234567890',
    database: 'appUsuarios'
  });
}

db.connect(err => {
  if (err) {
    console.error('Error conectando a MySQL:', err);
    process.exit(1);
  }
  console.log('Conectado a MySQL');
});
// —————————————
// 2) Configuración de Nodemailer
// —————————————
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'tucorreo@gmail.com',   // ← reemplaza
    pass: 'tu_app_password'       // ← usa App Password si es Gmail
  }
});
async function enviarCorreo(destinatario, asunto, texto) {
  const mailOptions = {
    from: 'Botón de Pánico <tucorreo@gmail.com>',
    to: destinatario,
    subject: asunto,
    text: texto
  };
  return transporter.sendMail(mailOptions);
}

// —————————————
// 3) Endpoint de LOGIN
// —————————————
app.post('/login', (req, res) => {
  const { correo, contrasena } = req.body;
  if (!correo || !contrasena) {
    return res.status(400).json({ message: 'Faltan datos' });
  }

  const query = 'SELECT * FROM usuarios WHERE correo = ? AND contrasena = ?';
  db.query(query, [correo, contrasena], (err, results) => {
    if (err) {
      console.error('Error en login:', err);
      return res.status(500).json({ message: 'Error en la base de datos' });
    }
    if (results.length > 0) {
      const user = results[0];
      return res.json({
        message: 'Login exitoso',
        usuario: {
          id:     user.id,
          nombre: user.nombre,
          correo: user.correo
        }
      });
    } else {
      return res.status(401).json({ message: 'Correo o contraseña incorrectos' });
    }
  });
});

// —————————————
// 4) Guardar/actualizar Expo Push Token
// —————————————
app.post('/save-token', (req, res) => {
  const { usuario_id, token } = req.body;
  if (!usuario_id || !token) {
    return res.status(400).json({ message: 'Faltan usuario_id o token' });
  }
  const query = `
    INSERT INTO expo_tokens (usuario_id, token)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE token = VALUES(token)
  `;
  db.query(query, [usuario_id, token], err => {
    if (err) {
      console.error('Error guardando token:', err);
      return res.status(500).json({ message: 'Error en la base de datos' });
    }
    res.json({ message: 'Token guardado correctamente' });
  });
});

// —————————————
// 5) Envío de notificación vía Expo Push
// —————————————
async function enviarNotificacionExpo(token, title, body) {
  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: token, title, body })
  });
}

// —————————————————————————————
// 6) Crear reporte con nivel y usuario_id
// —————————————————————————————
app.post('/reportes', (req, res) => {
  const { descripcion, latitud, longitud, nivel, usuario_id } = req.body;
  if (!descripcion || !latitud || !longitud || !nivel || !usuario_id) {
    return res.status(400).json({ message: 'Faltan datos obligatorios' });
  }

  const insertQuery = `
    INSERT INTO reportes (descripcion, latitud, longitud, nivel)
    VALUES (?, ?, ?, ?)
  `;
  db.query(insertQuery, [descripcion, latitud, longitud, nivel], async (err, result) => {
    if (err) {
      console.error('Error insertando reporte:', err);
      return res.status(500).json({ message: 'Error en la base de datos' });
    }
    const reporteId = result.insertId;

    // 6.1 Enviar correo si nivel === 'rojo'
    if (nivel === 'rojo') {
      const asunto = '🚨 Alerta Roja - Botón de Pánico';
      const texto = `
¡Alerta Roja Recibida!

Usuario ID : ${usuario_id}
Descripción : ${descripcion}
Ubicación   : https://maps.google.com/?q=${latitud},${longitud}
      `;
      try {
        await enviarCorreo('vigilancia@instituto.edu.mx', asunto, texto);
      } catch (emailErr) {
        console.error('Error enviando correo:', emailErr);
      }
    }

    // 6.2 Notificar a usuarios cercanos (< 1 km)
    db.query('SELECT usuario_id, token FROM expo_tokens', (errTokens, tokens) => {
      if (errTokens) {
        console.error('Error obteniendo tokens:', errTokens);
      } else {
        db.query('SELECT id, latitud, longitud FROM reportes', (errReps, reports) => {
          if (errReps) {
            console.error('Error obteniendo reportes:', errReps);
          } else {
            reports.forEach(r => {
              const dist = haversine(
                { lat: latitud, lon: longitud },
                { lat: parseFloat(r.latitud), lon: parseFloat(r.longitud) }
              );
              if (dist <= 1000 && r.id !== usuario_id) {
                tokens.forEach(async ({ usuario_id: uid, token }) => {
                  if (uid === r.id) {
                    await enviarNotificacionExpo(
                      token,
                      '🚨 Alerta Cercana',
                      `Nivel: ${nivel.toUpperCase()}\n${descripcion}`
                    );
                  }
                });
              }
            });
          }
        });
      }
    });

    res.status(201).json({ message: 'Reporte creado correctamente', id: reporteId });
  });
});

// —————————————
// 7) Endpoints GET, DELETE existentes
// —————————————
app.get('/reportes', (req, res) => {
  db.query('SELECT * FROM reportes ORDER BY fecha DESC', (err, rows) => {
    if (err) {
      console.error('Error al obtener reportes:', err);
      return res.status(500).json({ message: 'Error en la base de datos' });
    }
    res.json(rows);
  });
});

app.get('/reportes/:id', (req, res) => {
  db.query('SELECT * FROM reportes WHERE id = ?', [req.params.id], (err, rows) => {
    if (err) {
      console.error('Error al obtener reporte:', err);
      return res.status(500).json({ message: 'Error en la base de datos' });
    }
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Reporte no encontrado' });
    }
    res.json(rows[0]);
  });
});

app.delete('/reportes/:id', (req, res) => {
  db.query('DELETE FROM reportes WHERE id = ?', [req.params.id], (err, result) => {
    if (err) {
      console.error('Error al eliminar reporte:', err);
      return res.status(500).json({ message: 'Error en la base de datos' });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Reporte no encontrado' });
    }
    res.json({ message: 'Reporte eliminado correctamente' });
  });
});

// —————————————
// 8) Iniciar servidor
// —————————————
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en http://0.0.0.0:${PORT}`);
});
