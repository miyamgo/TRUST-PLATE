const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const pool = require('../db'); // Panggil DB

// =========================================================
// CUSTOM LOGGER KHUSUS VENDOR ROUTE
// =========================================================
const getTimestamp = () => new Date().toISOString().replace('T', ' ').substring(0, 19);
const logInfo = (msg) => console.log(`\x1b[36m[VENDOR-API]\x1b[0m ${getTimestamp()} | \x1b[32mINFO\x1b[0m | ${msg}`);
const logWarn = (msg) => console.log(`\x1b[33m[VENDOR-API]\x1b[0m ${getTimestamp()} | \x1b[33mWARN\x1b[0m | ${msg}`);
const logErr = (msg) => console.log(`\x1b[31m[VENDOR-API]\x1b[0m ${getTimestamp()} | \x1b[31mERROR\x1b[0m | ${msg}`);

// =========================================================
// SETTING MULTER (MENERIMA 2 FILE SEKALIGUS)
// =========================================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'uploads/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'));
    }
});
const upload = multer({ storage: storage });

// =========================================================
// API 1: GATEWAY AUDIT AI (NODE.JS -> PYTHON)
// =========================================================
router.post('/audit-ai', upload.fields([{ name: 'fotoMakanan', maxCount: 1 }, { name: 'fileNota', maxCount: 1 }]), async (req, res) => {
    logInfo("Menerima permintaan validasi AI dari Frontend...");
    
    try {
        if (!req.files || !req.files['fotoMakanan']) {
            logWarn("Vendor tidak melampirkan Foto Makanan!");
            return res.status(400).json({ success: false, message: "Foto makanan wajib diupload!" });
        }

        const vendorId = req.body.vendorId || "VENDOR_MANDIRI_01";
        const sekolah = req.body.sekolah || "Tidak Diketahui";
        
        // Tangkap array harga bebas dari frontend
        const logBahanArray = JSON.parse(req.body.logBahan || '[]');
        
        const fotoPathLocal = req.files['fotoMakanan'][0].path;
        const notaPathLocal = req.files['fileNota'] ? req.files['fileNota'][0].path : '';
        
        const fotoUrl = `/uploads/${req.files['fotoMakanan'][0].filename}`;
        const notaUrl = req.files['fileNota'] ? `/uploads/${req.files['fileNota'][0].filename}` : null;

        logInfo(`Menyusun payload untuk Python AI (Item belanja: ${logBahanArray.length} items)`);

        // Lempar data mentah ke Python, biarkan Python yang pusing mikir Fuzzy Logic & OCR!
        const pythonPayload = {
            nama_vendor: vendorId, 
            harga_komoditas: logBahanArray, // Kirim list utuh
            foto_path: fotoPathLocal,
            nota_path: notaPathLocal // Kirim path nota untuk dibaca OCR
        };

        logInfo("Menembak ke Server Python (Port 5001)...");
        const responseAI = await axios.post('http://localhost:5001/api/analisis-awal', pythonPayload);

        const hasilAITerbaca = responseAI.data;
        logInfo("Balasan dari Python Diterima! Meneruskan ke Frontend.");

        // Kembalikan ke Frontend dengan menyertakan status Dokumen (OCR)
        res.json({
            success: true,
            data: { 
                vendorId, sekolah, fileUrl: fotoUrl, notaUrl: notaUrl, 
                ai_audit: {
                    gizi: { 
                        status: hasilAITerbaca.analisis_gizi.status, 
                        detail: hasilAITerbaca.analisis_gizi.deteksi_visual 
                    },
                    dokumen: { 
                        status: hasilAITerbaca.analisis_dokumen.status, 
                        detail: hasilAITerbaca.analisis_dokumen.catatan 
                    },
                    harga: { 
                        status: hasilAITerbaca.analisis_harga.status_audit, 
                        detail: hasilAITerbaca.analisis_harga.catatan_sistem 
                    }
                } 
            }
        });
    } catch (err) { 
        logErr(`Gagal memproses AI Server: ${err.message}`);
        res.status(500).json({ success: false, message: "Gagal memproses AI Server." }); 
    }
});

// =========================================================
// API 2: EKSEKUSI SMART CONTRACT & DATABASE GOV
// =========================================================
router.post('/submit-ledger', async (req, res) => {
    logInfo("Menerima instruksi Segel Smart Contract...");
    try {
        const { vendorId, sekolah, fileUrl, notaUrl, menu, kalori, giziStatus, hargaStatus } = req.body;
        
        logInfo("Menghubungkan ke node Blockchain (RPC)...");
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        
        const contractABI = [{ "inputs": [ { "internalType": "string", "name": "_vendorId", "type": "string" }, { "internalType": "string", "name": "_fileUrl", "type": "string" }, { "internalType": "string", "name": "_giziStatus", "type": "string" }, { "internalType": "string", "name": "_hargaStatus", "type": "string" } ], "name": "submitReport", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" }];
        const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);
        
        logInfo(`Menulis transaksi ke Ledger untuk Vendor: ${vendorId}`);
        const tx = await contract.submitReport(vendorId, fileUrl, giziStatus, hargaStatus, { gasLimit: 3000000 });
        await tx.wait();
        logInfo(`\x1b[32mTRANSAKSI BLOCKCHAIN BERHASIL!\x1b[0m Hash: ${tx.hash}`);

        logInfo("Menyimpan detail ke Database PostgreSQL...");
        const queryText = `INSERT INTO laporan_harian (vendor_id, sekolah, file_url, nota_url, menu_makanan, kalori, gizi_status, harga_status, tx_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`;
        await pool.query(queryText, [vendorId, sekolah, fileUrl, notaUrl, menu, kalori, giziStatus, hargaStatus, tx.hash]);

        logInfo("Pencairan Escrow Selesai. Data terkunci.");
        res.json({ success: true, tx_hash: tx.hash });
    } catch (err) { 
        logErr(`Gagal segel ke Web3/DB: ${err.message}`);
        res.status(500).json({ success: false, message: err.message }); 
    }
});

// =========================================================
// API 3: AMBIL RIWAYAT LAPORAN VENDOR
// =========================================================
router.get('/riwayat', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM laporan_harian ORDER BY created_at DESC`);
        res.json({ success: true, data: result.rows });
    } catch (err) { 
        logErr(`Gagal ambil riwayat: ${err.message}`);
        res.status(500).json({ success: false, message: "Gagal mengambil riwayat." }); 
    }
});

// =========================================================
// API 4: SUBMIT RAB
// =========================================================
router.post('/submit-rab', async (req, res) => {
    logInfo("Menerima pengajuan RAB baru...");
    try {
        const { vendorId, sekolah, jumlahPorsi, totalAnggaran, rincianBahan } = req.body;
        const queryText = `INSERT INTO rab_pengajuan (vendor_id, sekolah, jumlah_porsi, total_anggaran, status, rincian_bahan) VALUES ($1, $2, $3, $4, 'Menunggu Review Pemkot', $5) RETURNING id`;
        const dbResult = await pool.query(queryText, [vendorId, sekolah, jumlahPorsi, totalAnggaran, rincianBahan]);
        
        logInfo(`RAB berhasil diajukan dengan ID: ${dbResult.rows[0].id}`);
        res.json({ success: true, message: "RAB diajukan.", id: dbResult.rows[0].id });
    } catch (err) { 
        logErr(`Gagal simpan RAB: ${err.message}`);
        res.status(500).json({ success: false, message: "Gagal menyimpan RAB." }); 
    }
});

// =========================================================
// API 5: AMBIL RIWAYAT RAB KHUSUS VENDOR
// =========================================================
router.get('/my-rab', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM rab_pengajuan WHERE vendor_id = '0x8F...A12B (Dapur Mandiri)' ORDER BY created_at DESC`);
        res.json({ success: true, data: result.rows });
    } catch (err) { 
        logErr(`Gagal ambil RAB vendor: ${err.message}`);
        res.status(500).json({ success: false, message: "Gagal mengambil RAB." }); 
    }
});

module.exports = router;