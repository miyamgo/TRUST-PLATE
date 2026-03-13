require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// IMPORT ROUTER KITA YANG SUDAH RAPI
const vendorRoutes = require('./routes/vendor');
const govRoutes = require('./routes/gov');
const masterRoutes = require('./routes/master');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================
// CUSTOM ENTERPRISE LOGGING MIDDLEWARE
// =========================================================
const getTimestamp = () => {
    const now = new Date();
    // Format: YYYY-MM-DD HH:mm:ss
    return now.toISOString().replace('T', ' ').substring(0, 19);
};

app.use((req, res, next) => {
    const start = Date.now();
    // Jalankan setelah response selesai dikirim
    res.on('finish', () => {
        const duration = Date.now() - start;
        
        // Warna warni terminal: Hijau (OK), Merah (Error), Kuning (Redirect)
        let statusColor = '\x1b[32m'; // Hijau
        if (res.statusCode >= 500) statusColor = '\x1b[31m'; // Merah
        else if (res.statusCode >= 400) statusColor = '\x1b[33m'; // Kuning
        const resetColor = '\x1b[0m';

        console.log(`${getTimestamp()} | NODE-SERVER | ${req.method} ${req.originalUrl} - ${statusColor}${res.statusCode}${resetColor} (${duration}ms)`);
    });
    next();
});

// =========================================================
// MIDDLEWARE GLOBAL
// =========================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Buka akses folder gambar dan PDF untuk Frontend (BAP Digital)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// =========================================================
// MENYAMBUNGKAN KABEL (ROUTING)
// =========================================================
app.use('/api/vendor', vendorRoutes); 
app.use('/api/gov', govRoutes);       
app.use('/api', masterRoutes);        

// Tangani route yang tidak ditemukan (404 Fallback) - Diperbarui untuk Express 5.x
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan.' });
});

// NYALAKAN MESIN
app.listen(PORT, () => {
    console.log(`\n` + `═`.repeat(65));
    console.log(`🚀 [NODE.JS CORE] TRUST-PLATE BACKEND BERJALAN`);
    console.log(`📡 Port Active    : ${PORT}`);
    console.log(`🧩 Architecture   : Modular (Microservices Ready)`);
    console.log(`🗃️  Static Access  : /uploads terbuka untuk publik`);
    console.log(`═`.repeat(65) + `\n`);
});