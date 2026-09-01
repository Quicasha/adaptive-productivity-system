// ============================================================
// secrets.example.h - prisijungimo duomenu sablonas
// ============================================================
// Nukopijuok si faila i secrets.h ir irasyk savo duomenis.
// secrets.h yra .gitignore sarase, todel i git jis nepateks.
//
//   cp secrets.example.h secrets.h
//
// ============================================================

#ifndef SECRETS_H
#define SECRETS_H

// WiFi tinklas, prie kurio jungiasi ESP32
const char* ssid = "TAVO_WIFI_PAVADINIMAS";
const char* password = "TAVO_WIFI_SLAPTAZODIS";

// MQTT brokerio adresas - kompiuterio IP tame paciame tinkle.
// Windows: ipconfig, Linux/macOS: ifconfig arba ip addr
const char* mqttServer = "192.168.1.100";

#endif
