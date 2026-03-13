// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract TrustPlateLedger {
    // Struktur data laporan
    struct Report {
        string vendorId;
        string fileUrl;
        string giziStatus;
        string hargaStatus;
        uint256 timestamp;
    }

    // Array untuk menyimpan seluruh laporan (Buku Besar)
    Report[] public reports;

    // Event/Log yang akan menyala setiap ada laporan baru masuk (Berguna untuk dilacak Frontend)
    event ReportSubmitted(
        uint256 indexed reportId,
        string vendorId,
        string giziStatus,
        string hargaStatus,
        uint256 timestamp
    );

    // Fungsi Utama: Eksekusi Laporan oleh Node.js
    function submitReport(
        string memory _vendorId,
        string memory _fileUrl,
        string memory _giziStatus,
        string memory _hargaStatus
    ) public returns (uint256) {
        
        uint256 reportId = reports.length;
        
        // Memasukkan data ke dalam Blockchain
        reports.push(Report({
            vendorId: _vendorId,
            fileUrl: _fileUrl,
            giziStatus: _giziStatus,
            hargaStatus: _hargaStatus,
            timestamp: block.timestamp
        }));

        // Memancarkan sinyal bahwa laporan sukses dicatat
        emit ReportSubmitted(reportId, _vendorId, _giziStatus, _hargaStatus, block.timestamp);
        
        return reportId;
    }

    // Fungsi untuk Walikota/Pemerintah menghitung total laporan
    function getTotalReports() public view returns (uint256) {
        return reports.length;
    }
}