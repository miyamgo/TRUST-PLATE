const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const pool = require('../db');

// API 5: DASHBOARD STATS
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
    } catch (err) { res.status(500).json({ success: false, message: "Gagal mengambil statistik." }); }
});

// API 6: LIST PENGAJUAN RAB
router.get('/list-rab', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM rab_pengajuan ORDER BY created_at DESC`);
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false, message: "Gagal mengambil daftar RAB." }); }
});

// API 7: APPROVE/TOLAK RAB (DENGAN BLOCKCHAIN)
router.post('/approve-rab', async (req, res) => {
    try {
        const { id, status, pesanRevisi } = req.body;
        let txHash = null;
        if (status === 'Disetujui') {
            const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
            const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
            const tx = await wallet.sendTransaction({ to: process.env.CONTRACT_ADDRESS, value: 0, data: ethers.hexlify(ethers.toUtf8Bytes(`ACC_RAB_TRUSTPLATE_ID_${id}`)) });
            await tx.wait();
            txHash = tx.hash;
        }
        await pool.query(`UPDATE rab_pengajuan SET status = $1, pesan_revisi = $2, tx_hash = $3 WHERE id = $4`, [status, pesanRevisi || null, txHash, id]);
        res.json({ success: true, tx_hash: txHash });
    } catch (err) { res.status(500).json({ success: false, message: "Gagal memproses persetujuan." }); }
});

// API 8: LIST LAPORAN ESCROW HARIAN
router.get('/list-pencairan', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM laporan_harian ORDER BY created_at DESC`);
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false, message: "Gagal mengambil daftar pencairan." }); }
});

module.exports = router;