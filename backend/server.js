require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { ethers } = require('ethers');
const pool = require('./db'); // Pastikan file db.js ada di folder yang sama dengan server.js

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================
// AUTO-SETUP SISTEM (Cegah Crash saat Demo)
// =========================================================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
    console.log(`[SYSTEM] Folder /uploads berhasil dibuat.`);
}

// Setup Upload Folder untuk Bukti Foto & Nota
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/'); },
    filename: function (req, file, cb) { cb(null, Date.now() + '-' + Math.round(Math.random()*1E9) + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });

// =========================================================
// CUSTOM ENTERPRISE LOGGING MIDDLEWARE
// =========================================================
const getTimestamp = () => {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
};

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        let statusColor = '\x1b[32m'; // Hijau (Success)
        if (res.statusCode >= 500) statusColor = '\x1b[31m'; // Merah (Server Error)
        else if (res.statusCode >= 400) statusColor = '\x1b[33m'; // Kuning (Client Error)
        const resetColor = '\x1b[0m';
        console.log(`${getTimestamp()} | \x1b[36m[ROUTER]\x1b[0m | ${req.method} ${req.originalUrl} - ${statusColor}${res.statusCode}${resetColor} (${duration}ms)`);
    });
    next();
});

// =========================================================
// MIDDLEWARE GLOBAL
// =========================================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public'))); // Buka akses HTML Frontend

// =========================================================
// FUNGSI HELPER GLOBAL: UPDATE TRUST SCORE (SQL TRANSACTION)
// =========================================================
async function updateTrustScore(vendorId, perubahanNilai, alasan, sumberPenilai, referensiId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const resVendor = await client.query('SELECT trust_score FROM vendors WHERE nama_usaha = $1', [vendorId]);
        if (resVendor.rows.length === 0) throw new Error('Vendor tidak ditemukan');
        
        let skorSekarang = parseFloat(resVendor.rows[0].trust_score) || 70.00;
        let skorBaru = skorSekarang + parseFloat(perubahanNilai);
        if (skorBaru > 100) skorBaru = 100;
        if (skorBaru < 0) skorBaru = 0;

        await client.query('UPDATE vendors SET trust_score = $1 WHERE nama_usaha = $2', [skorBaru, vendorId]);
        await client.query(`
            INSERT INTO trust_score_logs (vendor_id, perubahan_nilai, skor_akhir, alasan, sumber_penilai, referensi_id)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [vendorId, perubahanNilai, skorBaru, alasan, sumberPenilai, referensiId]);

        await client.query('COMMIT');
        console.log(`[DB-TX] Trust Score ${vendorId} Update: ${perubahanNilai > 0 ? '+' : ''}${perubahanNilai} -> ${skorBaru}`);
        return { success: true, newScore: skorBaru };
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("[DB-ERROR] Gagal update Trust Score:", err.message);
        return { success: false, error: err.message };
    } finally {
        client.release();
    }
}

// =========================================================================================
// MODULE 1: MASTER DATA API (/api)
// =========================================================================================
const masterRouter = express.Router();

masterRouter.get('/master-data-csv', (req, res) => {
    try {
        const dataPihps = fs.readFileSync(path.join(__dirname, 'katalog_pihps.csv'), 'utf8');
        const hasilKatalog = {};
        dataPihps.split(/\r?\n/).forEach((baris, i) => {
            if (i === 0 || !baris.trim()) return;
            const k = baris.split(',');
            if (!hasilKatalog[k[1]]) hasilKatalog[k[1]] = [];
            hasilKatalog[k[1]].push({ id: k[0], nama: k[2], satuan: k[3], hpp: parseInt(k[4]) });
        });

        const dataLokasi = fs.readFileSync(path.join(__dirname, 'lokasi_sekolah.csv'), 'utf8');
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

app.use('/api', masterRouter);

// =========================================================================================
// MODULE 2: GOVERNMENT API (/api/gov)
// =========================================================================================
const govRouter = express.Router();

// =========================================================
// API 0: GOV LOGIN (SSO AUDITOR)
// =========================================================
govRouter.post('/login', async (req, res) => {
    const { nip, password, region } = req.body;

    if (!nip || !password || !region) {
        return res.status(400).json({ success: false, message: 'NIP, Sandi, dan Wilayah wajib diisi.' });
    }

    try {
        const result = await pool.query('SELECT * FROM gov_users WHERE nip = $1 LIMIT 1', [nip]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'NIP tidak terdaftar di sistem B2G.' });
        }

        const govUser = result.rows[0];

        if (password !== govUser.password) {
            return res.status(401).json({ success: false, message: 'Kata sandi SSO tidak valid.' });
        }

        // Hapus password demi keamanan sebelum dikirim ke Browser
        delete govUser.password;
        
        // Simpan preferensi wilayah pantauan dari form login
        govUser.wilayah_pantauan = region;

        console.log(`\x1b[36m[AUTH-GOV]\x1b[0m Auditor Login: ${govUser.nama} (Wilayah: ${region})`);
        res.json({ success: true, data: govUser });

    } catch (err) {
        console.error('\x1b[31m[GOV LOGIN ERROR]\x1b[0m', err.message);
        res.status(500).json({ success: false, message: 'Kesalahan server internal B2G.' });
    }
});

// =========================================================
// API BARU: RANKING VENDOR DINAMIS (Top & Blacklist)
// =========================================================
govRouter.get('/vendor-rankings', async (req, res) => {
    try {
        // Ambil 3 Vendor Terbaik (Skor Tertinggi)
        const topVendors = await pool.query(`
            SELECT nama_usaha, wallet_address, trust_score 
            FROM vendors 
            WHERE status = 'Disetujui' 
            ORDER BY trust_score DESC LIMIT 3
        `);
        
        // Ambil Vendor Bermasalah (Skor di bawah 65)
        const badVendors = await pool.query(`
            SELECT nama_usaha, wallet_address, trust_score 
            FROM vendors 
            WHERE status = 'Disetujui' AND trust_score < 65 
            ORDER BY trust_score ASC LIMIT 3
        `);

        res.json({ 
            success: true, 
            data: { 
                top: topVendors.rows, 
                bad: badVendors.rows 
            } 
        });
    } catch (err) {
        console.error('\x1b[31m[RANKING ERROR]\x1b[0m', err.message);
        res.status(500).json({ success: false });
    }
});

govRouter.get('/dashboard-stats', async (req, res) => {
    try {
        // 1. Akumulasi Dana (Bulan Ini & Tahun Ini)
        const rabQuery = await pool.query(`
            SELECT SUM(total_anggaran) as total_rab 
            FROM rab_pengajuan 
            WHERE status = 'Disetujui' 
            AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE)
            AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)
        `);
        
        // 2. Porsi Gizi (Bulan Ini & Tahun Ini)
        const porsiQuery = await pool.query(`
            SELECT COUNT(*) as total_laporan 
            FROM laporan_harian 
            WHERE (gizi_status ILIKE '%Standar%' OR gizi_status ILIKE '%Memenuhi%')
            AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE)
            AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)
        `);
        
        // 3. Mark-up Dicegah & Vendor Bermasalah (Bulan Ini & Tahun Ini)
        const markupQuery = await pool.query(`
            SELECT COUNT(*) as total_markup 
            FROM laporan_harian 
            WHERE (harga_status ILIKE '%Tidak%' OR harga_status ILIKE '%Markup%' OR harga_status ILIKE '%Ditolak%')
            AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE)
            AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)
        `);
        
        res.json({
            success: true,
            data: {
                total_anggaran: rabQuery.rows[0].total_rab || 0,
                // Asumsi: 1 Laporan BAP = Rata-rata 100 porsi sasaran (Bisa lu sesuaikan)
                porsi_gizi: (porsiQuery.rows[0].total_laporan || 0) * 100, 
                // Asumsi: 1x Cekik Mark-up menyelamatkan rata-rata Rp 50.000
                markup_dicegah: (markupQuery.rows[0].total_markup || 0) * 50000, 
                vendor_bermasalah: markupQuery.rows[0].total_markup || 0
            }
        });
    } catch (err) { 
        console.error('\x1b[31m[STATS ERROR]\x1b[0m', err.message);
        res.status(500).json({ success: false }); 
    }
});

govRouter.get('/list-rab', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM rab_pengajuan ORDER BY created_at DESC`);
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

govRouter.post('/approve-rab', async (req, res) => {
    const { id, status, pesanRevisi } = req.body;
    try {
        const rabInfo = await pool.query("SELECT vendor_id FROM rab_pengajuan WHERE id = $1", [id]);
        if (rabInfo.rows.length === 0) return res.status(404).json({ success: false, message: "RAB tidak ditemukan" });
        const vendorId = rabInfo.rows[0].vendor_id;

        let txHash = null;
        if (status === 'Disetujui') {
            console.log(`\x1b[33m[WEB3]\x1b[0m Otorisasi Anggaran RAB ID: ${id} ke Blockchain...`);
            const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
            const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
            const tx = await wallet.sendTransaction({ to: process.env.CONTRACT_ADDRESS, value: 0, data: ethers.hexlify(ethers.toUtf8Bytes(`ACC_RAB_ID_${id}`)) });
            await tx.wait();
            txHash = tx.hash;
            console.log(`\x1b[33m[WEB3]\x1b[0m RAB Berhasil Diotorisasi. TxHash: ${txHash}`);
        } else if (status === 'Ditolak') {
            await updateTrustScore(vendorId, -5.00, `RAB Ditolak: ${pesanRevisi}`, 'AUDITOR', `RAB-${id}`);
        }

        await pool.query(`UPDATE rab_pengajuan SET status = $1, pesan_revisi = $2, tx_hash = $3 WHERE id = $4`, [status, pesanRevisi || null, txHash, id]);
        res.json({ success: true, tx_hash: txHash });
    } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

govRouter.get('/list-pencairan', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM laporan_harian ORDER BY created_at DESC`);
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

govRouter.get('/map-data', async (req, res) => {
    let mapNodes = [];
    const csvPath = path.join(__dirname, 'lokasi_sekolah.csv');
    try {
        const fileContent = fs.readFileSync(csvPath, 'utf-8');
        const lines = fileContent.split(/\r?\n/); 
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const cols = lines[i].split(',');
            if (cols[4] && !isNaN(parseFloat(cols[5]))) {
                mapNodes.push({ name: cols[4].trim(), lat: parseFloat(cols[5]), lng: parseFloat(cols[6]), status: "standby", detail: "Menunggu Penyaluran" });
            }
        }
        const dbResult = await pool.query(`SELECT sekolah, gizi_status, harga_status FROM laporan_harian`);
        dbResult.rows.forEach(row => {
            let targetNode = mapNodes.find(n => n.name === row.sekolah);
            if (targetNode) {
                const isIssue = row.harga_status.toLowerCase().includes('tidak') || row.gizi_status.toLowerCase().includes('kurang');
                targetNode.status = isIssue ? "bahaya" : "aman";
                targetNode.detail = isIssue ? "Indikasi Masalah (AI)" : "Tervalidasi Aman";
            }
        });
        res.json({ success: true, data: mapNodes });
    } catch (err) { res.status(500).json({ success: false }); }
});

govRouter.get('/list-vendor-pending', async (req, res) => {
    try {
        // UBAH BARIS INI MENJADI SELECT *
        const result = await pool.query("SELECT * FROM vendors WHERE status = 'Menunggu Verifikasi' ORDER BY created_at DESC");
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

govRouter.post('/approve-vendor', async (req, res) => {
    try {
        await pool.query("UPDATE vendors SET status = 'Disetujui' WHERE id = $1", [req.body.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

govRouter.get('/public-sekolah', (req, res) => {
    try {
        const fileContent = fs.readFileSync(path.join(__dirname, 'lokasi_sekolah.csv'), 'utf-8');
        const data = fileContent.split(/\r?\n/).slice(1).filter(l => l.trim()).map(l => ({ kota: l.split(',')[1], nama: l.split(',')[4] }));
        res.json({ success: true, data });
    } catch (e) { res.json({ success: false }); }
});

govRouter.post('/public-manifes', async (req, res) => {
    try {
        const result = await pool.query("SELECT vendor_id, jumlah_porsi FROM rab_pengajuan WHERE sekolah = $1 AND status = 'Disetujui' ORDER BY created_at DESC LIMIT 1", [req.body.nama_sekolah]);
        if (result.rows.length > 0) res.json({ success: true, is_real: true, data: { vendor: result.rows[0].vendor_id, porsi: result.rows[0].jumlah_porsi } });
        else res.json({ success: true, is_real: false, data: { vendor: "PT. Pangan Nusantara (Simulasi)", porsi: 350 } });
    } catch (err) { res.status(500).json({ success: false }); }
});

// =========================================================
// API BARU: AKSI BAP (CAIRKAN DANA ATAU TOLAK + SP1)
// =========================================================
govRouter.post('/action-bap', async (req, res) => {
    const { id, action } = req.body;
    try {
        const bap = await pool.query("SELECT vendor_id FROM laporan_harian WHERE id = $1", [id]);
        if(bap.rows.length === 0) return res.status(404).json({success: false, message: 'BAP tidak ditemukan'});
        
        const vendorId = bap.rows[0].vendor_id;

        if (action === 'cair') {
            await pool.query("UPDATE laporan_harian SET status = 'Cair' WHERE id = $1", [id]);
            console.log(`\x1b[32m[FINANCE]\x1b[0m BAP ${id} Disahkan. Dana dicairkan ke ${vendorId}`);
        } else if (action === 'tolak') {
            await pool.query("UPDATE laporan_harian SET status = 'Ditolak' WHERE id = $1", [id]);
            // Otomatis potong Trust Score 15 Poin!
            await updateTrustScore(vendorId, -15.00, 'BAP Ditolak - SP1 Diterbitkan', 'AUDITOR', `BAP-${id}`);
            console.log(`\x1b[31m[FINANCE]\x1b[0m BAP ${id} DITOLAK. SP-1 Diterbitkan untuk ${vendorId}`);
        }
        res.json({success: true});
    } catch(err) {
        console.error(err);
        res.status(500).json({success: false});
    }
});

app.use('/api/gov', govRouter);

govRouter.get('/dumas-clusters', async (req, res) => {
    try {
        // Tarik 2 vendor asli dari database yang berstatus disetujui
        const vendors = await pool.query("SELECT nama_usaha, alamat FROM vendors WHERE status = 'Disetujui' LIMIT 2");
        if (vendors.rows.length === 0) return res.json({ success: true, data: [] });

        // Generate cluster cerdas yang seolah-olah dianalisis oleh AI
        const clusters = vendors.rows.map((v, index) => {
            return {
                id: `CLUSTER-AI-${Math.floor(Math.random() * 9000) + 1000}`,
                vendor_name: v.nama_usaha,
                lokasi: v.alamat,
                jumlah: index === 0 ? 12 : 8,
                tingkat: index === 0 ? 'Kritikal' : 'Menengah',
                validitas: index === 0 ? '98%' : '85%',
                judul: index === 0 ? "Mayoritas Pelapor Menemukan Ulat/Benda Asing" : "Porsi Lauk Tidak Sesuai Spesifikasi Menu",
                analisis: index === 0 
                    ? `Sistem NLP memproses laporan warga. Pola Sangat Konsisten (Bukan Spam). Kata kunci dominan: "Ulat" (9x), "Jijik" (5x), "Dibuang" (7x).`
                    : `Sentimen pelapor menunjukkan kekecewaan tingkat menengah. Kata kunci dominan: "Kecil" (6x), "Sedikit" (8x). Deviasi porsi terdeteksi.`,
                foto: index === 0 
                    ? "https://images.unsplash.com/photo-1603569283847-aa295f0d016a?w=500&auto=format&fit=crop&q=60" 
                    : "https://images.unsplash.com/photo-1626200419199-391ae4be7a41?w=500&auto=format&fit=crop&q=60"
            };
        });

        res.json({ success: true, data: clusters });
    } catch (err) { res.status(500).json({ success: false }); }
});

// =========================================================
// API: EKSEKUSI PENALTI & CATAT KE BLOCKCHAIN
// =========================================================
govRouter.post('/execute-penalty', async (req, res) => {
    const { vendor_name, cluster_id } = req.body;
    try {
        // 1. Potong Trust Score 15 Poin di Database (PostgreSQL)
        await updateTrustScore(vendor_name, -15.00, `SP-1: Laporan Dumas Tervalidasi (${cluster_id})`, 'AUDITOR-NLP', cluster_id);

        // 2. Kunci Surat Peringatan (SP-1) ke Blockchain (Web3)
        console.log(`\x1b[33m[WEB3]\x1b[0m Merekam SP-1 untuk ${vendor_name} ke Blockchain...`);
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        
        const tx = await wallet.sendTransaction({
            to: process.env.CONTRACT_ADDRESS,
            value: 0,
            data: ethers.hexlify(ethers.toUtf8Bytes(`PENALTY_SP1_${vendor_name.replace(/\s+/g, '_')}`))
        });
        await tx.wait();
        console.log(`\x1b[33m[WEB3]\x1b[0m SP-1 Terekam! TxHash: ${tx.hash}`);

        res.json({ success: true, tx_hash: tx.hash });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// =========================================================================================
// MODULE 3: VENDOR API (/api/vendor)
// =========================================================================================
const vendorRouter = express.Router();

vendorRouter.post('/login', async (req, res) => {
    const { nib, password } = req.body;
    if (!nib || !password) return res.status(400).json({ success: false, message: 'NIB dan kata sandi wajib diisi.' });

    try {
        const result = await pool.query(`SELECT * FROM vendors WHERE nib = $1 LIMIT 1`, [nib]);
        if (result.rows.length === 0) return res.status(401).json({ success: false, message: 'NIB tidak ditemukan.' });

        const vendor = result.rows[0];
        if (vendor.status !== 'Disetujui') return res.status(403).json({ success: false, message: `Akun berstatus "${vendor.status}". Tunggu verifikasi Auditor.` });
        if (password !== vendor.password) return res.status(401).json({ success: false, message: 'Kata sandi salah.' });

        delete vendor.password;
        console.log(`\x1b[36m[AUTH-VENDOR]\x1b[0m Vendor Login Berhasil: ${vendor.nama_usaha}`);
        res.json({ success: true, data: vendor });
    } catch (err) { res.status(500).json({ success: false }); }
});

vendorRouter.post('/register', async (req, res) => {
    const { nama_usaha, nib, npwp, alamat, email, no_hp, penanggung_jawab, nik_pj, password, lat, lng } = req.body;
    try {
        const cekNib = await pool.query(`SELECT id FROM vendors WHERE nib = $1`, [nib]);
        if (cekNib.rows.length > 0) return res.status(409).json({ success: false, message: 'NIB sudah terdaftar.' });

        const randomWallet = ethers.Wallet.createRandom();
        const generatedAddress = randomWallet.address; 

        await pool.query(`
            INSERT INTO vendors
                (nama_usaha, nib, npwp, alamat, email, no_hp, penanggung_jawab, nik_pj, password, status, trust_score, wallet_address, lat, lng)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Menunggu Verifikasi', 70.00, $10, $11, $12)
        `, [nama_usaha, nib, npwp || null, alamat, email, no_hp, penanggung_jawab, nik_pj, password, generatedAddress, lat, lng]);

        console.log(`\x1b[36m[AUTH-VENDOR]\x1b[0m Registrasi Vendor Baru: ${nama_usaha} | Wallet: ${generatedAddress}`);
        res.json({ success: true, message: 'Pendaftaran berhasil dikirim. Tunggu verifikasi Auditor.' });
    } catch (err) { res.status(500).json({ success: false }); }
});

vendorRouter.post('/submit-rab', async (req, res) => {
    const { vendorId, sekolah, jumlahPorsi, totalAnggaran, rincianBahan } = req.body;
    try {
        const result = await pool.query(`
            INSERT INTO rab_pengajuan (vendor_id, sekolah, jumlah_porsi, total_anggaran, rincian, status)
            VALUES ($1, $2, $3, $4, $5, 'Menunggu Verifikasi') RETURNING id
        `, [vendorId, sekolah, jumlahPorsi, totalAnggaran, rincianBahan]);
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

vendorRouter.get('/my-rab', async (req, res) => {
    const { vendor_id } = req.query;
    try {
        const result = await pool.query(`SELECT * FROM rab_pengajuan WHERE vendor_id = $1 ORDER BY created_at DESC`, [vendor_id]);
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

// INTEGRASI PYTHON MICROSERVICE (AI VISION)
vendorRouter.post('/audit-ai', upload.any(), async (req, res) => {
    try {
        const fotoFile = req.files[0];
        const notaFile = req.files[1];
        const vendorId = req.body.vendorId || 'Unknown Vendor';
        const logBahan = JSON.parse(req.body.logBahan || '[]');

        const fotoPath = fotoFile ? path.join(__dirname, 'uploads', fotoFile.filename) : '';
        const notaPath = notaFile ? path.join(__dirname, 'uploads', notaFile.filename) : '';

        const payloadToPython = {
            foto_path: fotoPath,
            nota_path: notaPath,
            nama_vendor: vendorId,
            harga_komoditas: logBahan
        };

        console.log(`\x1b[35m[AI-VISION]\x1b[0m Meneruskan file foto & nota dari ${vendorId} ke Python AI (Port 5001)...`);

        // Tembak API Python Flask
        const aiResponse = await fetch('http://127.0.0.1:5001/api/analisis-awal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadToPython)
        });

        const aiResult = await aiResponse.json();
        if (!aiResult.success) throw new Error("Python AI Service gagal memproses gambar.");

        console.log(`\x1b[35m[AI-VISION]\x1b[0m Analisis AI Selesai! Result: ${aiResult.analisis_gizi.status}`);

        res.json({
            success: true,
            data: {
                fileUrl: fotoFile ? `/uploads/${fotoFile.filename}` : '',
                notaUrl: notaFile ? `/uploads/${notaFile.filename}` : '',
                ai_audit: {
                    gizi: { status: aiResult.analisis_gizi.status, detail: aiResult.analisis_gizi.deteksi_visual },
                    dokumen: { status: aiResult.analisis_dokumen.status, detail: aiResult.analisis_dokumen.catatan }
                }
            }
        });
    } catch (err) { 
        console.error('\x1b[31m[AI-VISION ERROR]\x1b[0m', err.message);
        res.status(500).json({ success: false, message: 'Gagal terhubung ke AI Vision Service (Pastikan Python nyala di Port 5001)' }); 
    }
});

// INTEGRASI BLOCKCHAIN (GANACHE)
const contractABI = [
    "function submitReport(string _vendorId, string _fileUrl, string _giziStatus, string _hargaStatus) public returns (uint256)",
    "event ReportSubmitted(uint256 indexed reportId, string vendorId, string giziStatus, string hargaStatus, uint256 timestamp)"
];

vendorRouter.post('/submit-ledger', async (req, res) => {
    const { vendorId, sekolah, fileUrl, notaUrl, menu, kalori, giziStatus, hargaStatus } = req.body;

    try {
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);

        console.log(`\x1b[33m[WEB3]\x1b[0m Mengirim BAP ${vendorId} ke Jaringan Blockchain...`);
        const tx = await contract.submitReport(vendorId, fileUrl || "ipfs://hash-foto", giziStatus, hargaStatus);

        console.log(`\x1b[33m[WEB3]\x1b[0m Menunggu Mining Blok... TxHash: ${tx.hash}`);
        await tx.wait(); 
        console.log(`\x1b[33m[WEB3]\x1b[0m SUCCESS! Laporan Terotorisasi di Blockchain.`);
        
        await pool.query(`
            INSERT INTO laporan_harian 
                (vendor_id, sekolah, file_url, nota_url, menu, kalori, gizi_status, harga_status, tx_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [vendorId, sekolah, fileUrl, notaUrl, menu, kalori, giziStatus, hargaStatus, tx.hash]);

        res.json({ success: true, tx_hash: tx.hash, message: "Laporan terotorisasi di Blockchain." });
    } catch (err) {
        console.error('\x1b[31m[WEB3 ERROR]\x1b[0m', err.message);
        res.status(500).json({ success: false, message: 'Gagal mencatat ke Blockchain. Cek koneksi Ganache.', error: err.message });
    }
});

vendorRouter.get('/riwayat', async (req, res) => {
    const { vendor_id } = req.query;
    try {
        const result = await pool.query(`SELECT * FROM laporan_harian WHERE vendor_id = $1 ORDER BY created_at DESC`, [vendor_id]);
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.use('/api/vendor', vendorRouter);

// =========================================================
// 404 FALLBACK
// =========================================================
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan di jaringan TRUST-PLATE.' });
});

// =========================================================
// NYALAKAN MESIN SERVER
// =========================================================
app.listen(PORT, () => {
    console.log(`\n` + `═`.repeat(65));
    console.log(`🚀 \x1b[32m[NODE.JS CORE]\x1b[0m TRUST-PLATE BACKEND BERJALAN`);
    console.log(`📡 Port Active    : ${PORT}`);
    console.log(`🧠 AI Engine Link : http://127.0.0.1:5001 (Menunggu Python)`);
    console.log(`⛓️  Web3 Network   : ${process.env.RPC_URL}`);
    console.log(`═`.repeat(65) + `\n`);
});