const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const pool = require('../db');
const fs = require('fs');
const path = require('path');

// =========================================================
// FUNGSI GLOBAL: UPDATE TRUST SCORE DENGAN SQL TRANSACTION
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
        return { success: true, newScore: skorBaru };
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("[GOV-ERROR] Gagal update Trust Score:", err.message);
        return { success: false, error: err.message };
    } finally {
        client.release();
    }
}

// API 1: DASHBOARD STATS
router.get('/dashboard-stats', async (req, res) => {
    try {
        const rabQuery = await pool.query("SELECT SUM(total_anggaran) as total_rab FROM rab_pengajuan WHERE status = 'Disetujui'");
        const porsiQuery = await pool.query(`SELECT COUNT(*) as total_laporan FROM laporan_harian WHERE gizi_status ILIKE '%Standar%' OR gizi_status ILIKE '%Memenuhi%'`);
        const markupQuery = await pool.query(`SELECT COUNT(*) as total_markup FROM laporan_harian WHERE harga_status ILIKE '%Tidak%' OR harga_status ILIKE '%Markup%' OR harga_status ILIKE '%Ditolak%'`);
        
        res.json({
            success: true,
            data: {
                total_anggaran: rabQuery.rows[0].total_rab || 0,
                porsi_gizi: (porsiQuery.rows[0].total_laporan || 0) * 100,
                markup_dicegah: (markupQuery.rows[0].total_markup || 0) * 50000,
                vendor_bermasalah: markupQuery.rows[0].total_markup || 0
            }
        });
    } catch (err) { 
        res.status(500).json({ success: false, message: "Gagal mengambil statistik." }); 
    }
});

// API 2: LIST PENGAJUAN RAB
router.get('/list-rab', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM rab_pengajuan ORDER BY created_at DESC`);
        res.json({ success: true, data: result.rows });
    } catch (err) { 
        res.status(500).json({ success: false, message: "Gagal mengambil daftar RAB." }); 
    }
});

// API 3: APPROVE/TOLAK RAB (DENGAN BLOCKCHAIN & PENALTI SKOR)
router.post('/approve-rab', async (req, res) => {
    const { id, status, pesanRevisi } = req.body;
    try {
        // Ambil info vendor untuk penalti
        const rabInfo = await pool.query("SELECT vendor_id FROM rab_pengajuan WHERE id = $1", [id]);
        if (rabInfo.rows.length === 0) return res.status(404).json({ success: false, message: "RAB tidak ditemukan" });
        const vendorId = rabInfo.rows[0].vendor_id;

        let txHash = null;
        if (status === 'Disetujui') {
            const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
            const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
            const tx = await wallet.sendTransaction({ 
                to: process.env.CONTRACT_ADDRESS, 
                value: 0, 
                data: ethers.hexlify(ethers.toUtf8Bytes(`ACC_RAB_ID_${id}`)) 
            });
            await tx.wait();
            txHash = tx.hash;
        } else if (status === 'Ditolak') {
            // Penalti otomatis -5 poin jika RAB ditolak
            await updateTrustScore(vendorId, -5.00, `RAB Ditolak: ${pesanRevisi}`, 'AUDITOR', `RAB-${id}`);
        }

        await pool.query(`UPDATE rab_pengajuan SET status = $1, pesan_revisi = $2, tx_hash = $3 WHERE id = $4`, [status, pesanRevisi || null, txHash, id]);
        res.json({ success: true, tx_hash: txHash });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ success: false, message: "Gagal memproses persetujuan." }); 
    }
});

// API 4: LIST LAPORAN ESCROW HARIAN
router.get('/list-pencairan', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM laporan_harian ORDER BY created_at DESC`);
        res.json({ success: true, data: result.rows });
    } catch (err) { 
        res.status(500).json({ success: false, message: "Gagal mengambil daftar pencairan." }); 
    }
});

// API 5: MAP DATA GEOSPASIAL (CSV + DB)
router.get('/map-data', async (req, res) => {
    let mapNodes = [];
    const csvPath = path.join(__dirname, '../lokasi_sekolah.csv');
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

// API 6: LIST VENDOR PENDING (Untuk ACC Akun Baru)
router.get('/list-vendor-pending', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, nama_usaha, nib, alamat, status FROM vendors WHERE status = 'Menunggu Verifikasi' ORDER BY created_at DESC");
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

// API 7: APPROVE AKUN VENDOR
router.post('/approve-vendor', async (req, res) => {
    try {
        await pool.query("UPDATE vendors SET status = 'Disetujui' WHERE id = $1", [req.body.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// API 8: PUBLIC DROPDOWN SEKOLAH
router.get('/public-sekolah', (req, res) => {
    const csvPath = path.join(__dirname, '../lokasi_sekolah.csv');
    try {
        const fileContent = fs.readFileSync(csvPath, 'utf-8');
        const lines = fileContent.split(/\r?\n/).slice(1);
        const data = lines.filter(l => l.trim()).map(l => ({ kota: l.split(',')[1], nama: l.split(',')[4] }));
        res.json({ success: true, data });
    } catch (e) { res.json({ success: false }); }
});

// API 9: PUBLIC CEK MANIFES
router.post('/public-manifes', async (req, res) => {
    try {
        const result = await pool.query("SELECT vendor_id, jumlah_porsi FROM rab_pengajuan WHERE sekolah = $1 AND status = 'Disetujui' ORDER BY created_at DESC LIMIT 1", [req.body.nama_sekolah]);
        if (result.rows.length > 0) res.json({ success: true, is_real: true, data: { vendor: result.rows[0].vendor_id, porsi: result.rows[0].jumlah_porsi } });
        else res.json({ success: true, is_real: false, data: { vendor: "PT. Pangan Nusantara (Simulasi)", porsi: 350 } });
    } catch (err) { res.status(500).json({ success: false }); }
});

module.exports = router;