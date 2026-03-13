import logging
from flask import Flask, request, jsonify
from flask_cors import CORS

from services.vision_service import analyze_image
from services.anomaly_service import analyze_price
from services.document_service import validate_receipt

# Konfigurasi Log Server Utama
logging.basicConfig(level=logging.INFO, format="%(asctime)s | SERVER | %(message)s")
log = logging.getLogger("API-GATEWAY")

app = Flask(__name__)
CORS(app)

@app.route('/api/analisis-awal', methods=['POST'])
def analisis_awal():
    try:
        data = request.json
        foto_path = data.get('foto_path', '')
        nota_path = data.get('nota_path', '') 
        nama_vendor = data.get('nama_vendor', 'Unknown')
        harga_komoditas = data.get('harga_komoditas', {})

        print("\n" + "="*65)
        log.info(f"🚀 INCOMING AUDIT REQUEST DARI: {nama_vendor}")
        print("="*65)

        # 1. PILAR HARGA FORENSIK (Anomaly Service)
        hasil_harga = analyze_price(harga_komoditas)
        
        # Hitung total tagihan dari vendor (untuk dikirim ke OCR)
        # UPDATE: Sekarang mendukung tipe data List dari frontend inputan bebas
        total_lapor = 0
        if isinstance(harga_komoditas, list):
            for item in harga_komoditas:
                try:
                    total_lapor += int(item.get('price', 0))
                except (ValueError, TypeError, AttributeError):
                    pass
        elif isinstance(harga_komoditas, dict):
            for harga in harga_komoditas.values():
                try:
                    total_lapor += int(harga)
                except (ValueError, TypeError):
                    pass

        # 2. PILAR DOKUMEN (Document Service OCR)
        hasil_dokumen = {"status": "Tidak Ada Dokumen", "catatan": "Vendor tidak mengunggah nota."}
        if nota_path:
            # Kita lempar nota dan total tagihan ke OCR!
            hasil_dokumen = validate_receipt(nota_path, total_lapor)

        # 3. PILAR GIZI (Vision Service)
        hasil_gizi = analyze_image(foto_path)

        print("\n" + "="*65)
        log.info("📊 KESIMPULAN AUDIT AI TERPADU:")
        print(f"  [GIZI]    Status : {hasil_gizi['status']}")
        print(f"            Detail : {hasil_gizi['deteksi_visual']}")
        print(f"  [NOTA]    Status : {hasil_dokumen['status']}")
        print(f"            Detail : {hasil_dokumen['catatan']}")
        print(f"  [HARGA]   Status : {hasil_harga['status_audit']}")
        print(f"            Detail : {hasil_harga['catatan_sistem']}")
        print("="*65 + "\n")

        return jsonify({
            "success": True,
            "analisis_gizi": hasil_gizi,
            "analisis_dokumen": hasil_dokumen,
            "analisis_harga": hasil_harga
        })

    except Exception as e:
        log.error(f"FATAL ERROR: {str(e)}")
        return jsonify({"success": False, "message": str(e)}), 500

if __name__ == '__main__':
    print("\n" + "★"*65)
    print(" 🛡️  TRUST-PLATE AI FORENSIC MICROSERVICE ACTIVE  🛡️")
    print("★"*65 + "\n")
    app.run(host='0.0.0.0', port=5001, debug=False)