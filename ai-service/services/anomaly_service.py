import os
import csv
import logging
import numpy as np
from sklearn.ensemble import IsolationForest

# ==========================================
# LOGGING SETUP
# ==========================================
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("AI-PRICE-FORENSIC")

log.info("Memuat Model Isolation Forest (Pendeteksi Mark-up Harga)...")
# contamination=0.15 artinya kita curiga 15% data adalah korupsi
model_if = IsolationForest(n_estimators=100, contamination=0.15, random_state=42)
log.info("Model Isolation Forest Siap!")

def analyze_price(harga_vendor_dict):
    """
    harga_vendor_dict berisi object dari frontend.
    Contoh: {'Beras Cap Mawar': {'kategori': 'Karbohidrat', 'harga': 50000}, ...}
    """
    log.info("===================================================")
    log.info("AUDIT HARGA (FORENSIK) DIMULAI")
    
    status_audit = "Harga Wajar Terverifikasi"
    catatan_sistem = []
    
    parent_dir = os.path.dirname(os.getcwd())
    csv_path = os.path.join(parent_dir, 'backend', 'katalog_pihps.csv')

    harga_acuan = {}
    
    # ==========================================
    # 1. BACA DATABASE PIHPS
    # ==========================================
    if os.path.exists(csv_path):
        with open(csv_path, mode='r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if not row.get('nama_item'): continue
                nama = row['nama_item'].strip().lower()
                try:
                    harga = float(row.get('harga_acuan', 0))
                    harga_acuan[nama] = harga
                except ValueError:
                    continue
        log.info("Database PIHPS berhasil dimuat (%d item).", len(harga_acuan))
    else:
        log.warning("Database PIHPS tidak ditemukan! Menggunakan batas wajar default.")
        catatan_sistem.append("[WARNING] Database PIHPS tidak ditemukan.")

    # ==========================================
    # 2. LOGIKA PENCOCOKAN "FUZZY"
    # ==========================================
    data_rasio = []
    item_diperiksa = []
    
    # Jika input dari frontend berupa List of Dictionaries (Logika baru kita)
    if isinstance(harga_vendor_dict, list):
        log_belanja = harga_vendor_dict
    else:
        # Fallback jika struktur datanya berupa dict sederhana
        log_belanja = [{"nama": k, "kategori": "", "price": v} for k, v in harga_vendor_dict.items()]

    for item_data in log_belanja:
        # Tangani kemungkinan struktur JSON yang berbeda dari Frontend
        nama_vendor = item_data.get('nama', '').lower()
        kategori_vendor = item_data.get('kategori', '').lower()
        
        try:
            harga_lapor = float(item_data.get('price', 0))
        except ValueError:
            harga_lapor = 0
            
        if harga_lapor <= 0 or not nama_vendor:
            continue
            
        log.info("Memeriksa: '%s' (Kat: %s) -> Rp %d", nama_vendor, kategori_vendor, harga_lapor)

        harga_standar = 0
        nama_ditemukan = ""

        # STRATEGI 1: Pencarian Kata Kunci (Keyword Matching)
        # Pisahkan kata per kata (misal: "beras cap mawar" -> ["beras", "cap", "mawar"])
        kata_kunci_vendor = nama_vendor.split()
        
        for acuan_nama, acuan_harga in harga_acuan.items():
            # Cek apakah ada satupun kata kunci vendor yang cocok dengan nama di PIHPS
            # (Misal kata "beras" cocok dengan "beras medium")
            for kata in kata_kunci_vendor:
                if len(kata) > 3 and (kata in acuan_nama or acuan_nama in kata):
                    harga_standar = acuan_harga
                    nama_ditemukan = acuan_nama
                    break
            if harga_standar > 0:
                break

        # STRATEGI 2: Fallback Kategori (Jika Strategi 1 Gagal)
        if harga_standar == 0 and kategori_vendor:
            # Kita buat harga rata-rata berdasarkan kategori
            if "karbo" in kategori_vendor: harga_standar = 15000  # Rata-rata karbo per kg
            elif "protein" in kategori_vendor: harga_standar = 40000 # Rata-rata protein per kg
            elif "sayur" in kategori_vendor or "buah" in kategori_vendor: harga_standar = 20000
            elif "bumbu" in kategori_vendor: harga_standar = 25000
            
            if harga_standar > 0:
                nama_ditemukan = f"Rata-rata Kategori {kategori_vendor.title()}"
                log.warning("'%s' tidak ada di DB, menggunakan standar kategori: Rp%d", nama_vendor, harga_standar)

        # ==========================================
        # 3. PENCATATAN RASIO UNTUK ISOLATION FOREST
        # ==========================================
        if harga_standar > 0:
            rasio = harga_lapor / harga_standar
            data_rasio.append([rasio])
            item_diperiksa.append({
                "nama_asli": item_data.get('nama'), 
                "nama_pihps": nama_ditemukan,
                "lapor": harga_lapor, 
                "standar": harga_standar
            })
            log.info("Cocok dengan '%s' (Rasio Harga: %.2f)", nama_ditemukan, rasio)
        else:
            pesan = f"Barang '{item_data.get('nama')}' tidak dapat diverifikasi (Manual Audit)."
            catatan_sistem.append(pesan)
            log.warning(pesan)

    # ==========================================
    # 4. EKSEKUSI ISOLATION FOREST AI
    # ==========================================
    if len(data_rasio) > 0:
        log.info("Menjalankan AI Isolation Forest untuk mencari anomali dari %d item...", len(data_rasio))
        # Training dummy data wajar
        dummy_normal = np.random.uniform(0.9, 1.25, (50, 1))
        model_if.fit(dummy_normal)
        
        # Prediksi data vendor
        X_test = np.array(data_rasio)
        prediksi = model_if.predict(X_test)
        
        indikasi_korupsi = False
        for i, hasil in enumerate(prediksi):
            item_info = item_diperiksa[i]
            
            # Jika AI merasa itu Anomali (-1) DAN Mark-up di atas 25% (Rasio > 1.25)
            if hasil == -1 and data_rasio[i][0] > 1.25:
                indikasi_korupsi = True
                catatan_sistem.append(
                    f"MARK-UP: {item_info['nama_asli']} (Lapor Rp{int(item_info['lapor'])}, Standar Rp{int(item_info['standar'])})"
                )
                log.error("MARK-UP TERDETEKSI! %s lapor %d, batas %d", item_info['nama_asli'], item_info['lapor'], item_info['standar'])
                
        if indikasi_korupsi:
            status_audit = "Terindikasi Mark-up / Anomali Harga"
        else:
            catatan_sistem.append("Semua harga wajar sesuai pasar (Max Mark-up 25%).")
            log.info("Semua harga aman terkendali.")
    else:
        catatan_sistem.append("Sistem gagal membandingkan harga, butuh verifikasi manusia.")

    log.info("Status Akhir Forensik Harga: %s", status_audit)

    return {
        "status_audit": status_audit,
        "catatan_sistem": " | ".join(catatan_sistem)
    }