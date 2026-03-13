const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// API 9: BACA CSV
router.get('/master-data-csv', (req, res) => {
    try {
        const dataPihps = fs.readFileSync(path.join(__dirname, '../katalog_pihps.csv'), 'utf8'); // Perhatikan ../ karena file ada di luar folder routes
        const hasilKatalog = {};
        dataPihps.split(/\r?\n/).forEach((baris, i) => {
            if (i === 0 || !baris.trim()) return;
            const k = baris.split(',');
            if (!hasilKatalog[k[1]]) hasilKatalog[k[1]] = [];
            hasilKatalog[k[1]].push({ id: k[0], nama: k[2], satuan: k[3], hpp: parseInt(k[4]) });
        });

        const dataLokasi = fs.readFileSync(path.join(__dirname, '../lokasi_sekolah.csv'), 'utf8');
        const hasilLokasi = {}; 
        dataLokasi.split(/\r?\n/).forEach((baris, i) => {
            if (i === 0 || !baris.trim()) return;
            const k = baris.split(',');
            if (!hasilLokasi[k[1]]) hasilLokasi[k[1]] = {};
            if (!hasilLokasi[k[1]][k[2]]) hasilLokasi[k[1]][k[2]] = { pos: k[3], sekolah: [] };
            hasilLokasi[k[1]][k[2]].sekolah.push({ nama: k[4], lat: parseFloat(k[5]), lng: parseFloat(k[6]) });
        });

        res.json({ success: true, data: { katalog: hasilKatalog, lokasi: hasilLokasi } });
    } catch (err) { res.status(500).json({ success: false, message: "Gagal memproses CSV." }); }
});

module.exports = router;