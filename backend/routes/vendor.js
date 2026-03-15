// routes/vendor.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

// =========================================================
// POST /api/vendor/login
// =========================================================
router.post('/login', async (req, res) => {
    const { nib, password } = req.body;

    if (!nib || !password) {
        return res.status(400).json({
            success: false,
            message: 'NIB dan kata sandi wajib diisi.'
        });
    }

    try {
        const result = await pool.query(
            `SELECT * FROM vendors WHERE nib = $1 LIMIT 1`,
            [nib]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'NIB tidak ditemukan.'
            });
        }

        const vendor = result.rows[0];

        // Cek status akun
        if (vendor.status !== 'Disetujui') {
            return res.status(403).json({
                success: false,
                message: `Akun Anda berstatus "${vendor.status}". Tunggu verifikasi dari Auditor.`
            });
        }

        // Bandingkan password langsung (plain text)
        if (password !== vendor.password) {
            return res.status(401).json({
                success: false,
                message: 'Kata sandi salah.'
            });
        }

        // Hapus password sebelum dikirim ke frontend
        delete vendor.password;

        res.json({ success: true, data: vendor });

    } catch (err) {
        console.error('[VENDOR LOGIN ERROR]', err.message);
        res.status(500).json({ success: false, message: 'Kesalahan server internal.' });
    }
});

// =========================================================
// POST /api/vendor/register
// =========================================================
router.post('/register', async (req, res) => {
    const {
        nama_usaha, nib, npwp, alamat, email,
        no_hp, penanggung_jawab, nik_pj, password
    } = req.body;

    if (!nama_usaha || !nib || !alamat || !email || !no_hp || !penanggung_jawab || !nik_pj || !password) {
        return res.status(400).json({
            success: false,
            message: 'Semua field bertanda * wajib diisi.'
        });
    }

    if (password.length < 6) {
        return res.status(400).json({
            success: false,
            message: 'Kata sandi minimal 6 karakter.'
        });
    }

    try {
        // Cek NIB sudah terdaftar
        const cekNib = await pool.query(
            `SELECT id FROM vendors WHERE nib = $1`, [nib]
        );
        if (cekNib.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'NIB sudah terdaftar. Silakan login.'
            });
        }

        // Cek email sudah terdaftar
        const cekEmail = await pool.query(
            `SELECT id FROM vendors WHERE email = $1`, [email]
        );
        if (cekEmail.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Email sudah digunakan oleh akun lain.'
            });
        }

        // Insert langsung tanpa hash
        await pool.query(`
            INSERT INTO vendors
                (nama_usaha, nib, npwp, alamat, email, no_hp,
                 penanggung_jawab, nik_pj, password, status, trust_score)
            VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Menunggu Verifikasi', 70.00)
        `, [
            nama_usaha, nib, npwp || null, alamat, email,
            no_hp, penanggung_jawab, nik_pj, password
        ]);

        res.json({
            success: true,
            message: 'Pendaftaran berhasil dikirim. Tunggu verifikasi Auditor.'
        });

    } catch (err) {
        console.error('[VENDOR REGISTER ERROR]', err.message);
        res.status(500).json({ success: false, message: 'Kesalahan server internal.' });
    }
});

// =========================================================
// GET /api/vendor/profile
// =========================================================
router.get('/profile', async (req, res) => {
    const { nib } = req.query;

    if (!nib) {
        return res.status(400).json({ success: false, message: 'NIB diperlukan.' });
    }

    try {
        const result = await pool.query(
            `SELECT id, nama_usaha, nib, email, alamat, no_hp,
                    penanggung_jawab, status, trust_score, wallet_address
             FROM vendors WHERE nib = $1`,
            [nib]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan.' });
        }

        res.json({ success: true, data: result.rows[0] });

    } catch (err) {
        console.error('[VENDOR PROFILE ERROR]', err.message);
        res.status(500).json({ success: false });
    }
});

// =========================================================
// GET /api/vendor/riwayat-rab
// =========================================================
router.get('/riwayat-rab', async (req, res) => {
    const { vendor_id } = req.query;

    if (!vendor_id) {
        return res.status(400).json({ success: false, message: 'vendor_id diperlukan.' });
    }

    try {
        const result = await pool.query(
            `SELECT id, sekolah, jumlah_porsi, total_anggaran, status, 
                    pesan_revisi, tx_hash, created_at
             FROM rab_pengajuan
             WHERE vendor_id = $1
             ORDER BY created_at DESC`,
            [vendor_id]
        );

        res.json({ success: true, data: result.rows });

    } catch (err) {
        console.error('[VENDOR RAB ERROR]', err.message);
        res.status(500).json({ success: false });
    }
});

// =========================================================
// GET /api/vendor/trust-score-log
// =========================================================
router.get('/trust-score-log', async (req, res) => {
    const { vendor_id } = req.query;

    if (!vendor_id) {
        return res.status(400).json({ success: false, message: 'vendor_id diperlukan.' });
    }

    try {
        const result = await pool.query(
            `SELECT perubahan_nilai, skor_akhir, alasan, sumber_penilai, created_at
             FROM trust_score_logs
             WHERE vendor_id = $1
             ORDER BY created_at DESC
             LIMIT 20`,
            [vendor_id]
        );

        res.json({ success: true, data: result.rows });

    } catch (err) {
        console.error('[TRUST LOG ERROR]', err.message);
        res.status(500).json({ success: false });
    }
});

module.exports = router;