// ============================================================
// Adaptyvi produktyvumo palaikymo sistema – ESP32 firmware
// ============================================================
// Mikrovaldiklis atsakingas už:
// - Jutiklių duomenų nuskaitymą (SHT31, BH1750)
// - Aktuatorių valdymą (LED, ventiliatorius, buzeris, servo)
// - Duomenų siuntimą į serverį per MQTT
// - Komandų priėmimą iš serverio per MQTT
// - Autonominį veikimą kai serveris nepasiekiamas
// ============================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <BH1750.h>
#include "Adafruit_SHT31.h"
#include <FastLED.h>
#include <ESP32Servo.h>

// Prisijungimo duomenys laikomi atskirame faile, kuris neikeliamas i git.
// Nukopijuok secrets.example.h i secrets.h ir surasyk savo duomenis.
#include "secrets.h"

// ============================================================
// KONFIGŪRACIJA
// ============================================================

// WiFi ir MQTT prisijungimo duomenys ateina is secrets.h

const int mqttPort = 1883;

// GPIO kaiščių priskyrimai
#define BUZZER_PIN 23    // Pasyvus buzeris (KY-012)
#define LED_PIN 18       // WS2812B LED juostos duomenų kaištis
#define SERVO_PIN 5      // MG90S servo variklio valdymo kaištis
#define FAN_PIN 19       // Ventiliatoriaus valdymas per 2N2222

// LED juostos parametrai
#define NUM_LEDS 1      // LED skaičius juostoje
#define BRIGHTNESS 30    // Maksimalus ryškumas (ribojame dėl USB maitinimo)

// Laiko intervalai (milisekundėmis)
const unsigned long SENSOR_INTERVAL = 2000;   // Jutiklių nuskaitymo intervalas
const unsigned long PUBLISH_INTERVAL = 3000;  // Duomenų publikavimo intervalas
const unsigned long RECONNECT_INTERVAL = 5000; // Bandymo prisijungti intervalas

// ============================================================
// OBJEKTAI
// ============================================================

WiFiClient espClient;
PubSubClient mqtt(espClient);
BH1750 lightMeter;
Adafruit_SHT31 sht31 = Adafruit_SHT31();
CRGB leds[NUM_LEDS];
Servo myServo;

// ============================================================
// SISTEMOS BŪSENA
// ============================================================

// Jutiklių reikšmės
float temperature = 0;
float humidity = 0;
float light = 0;

// Aktuatorių būsena
bool fanOn = false;
String currentMode = "idle";
String ledColor = "blue";
int ledBrightness = BRIGHTNESS;
bool servoLocked = true;

// Ventiliatoriaus valdymo logika
bool manualFanOverride = false;  // true = rankinis valdymas aktyvus
float fanThreshold = 26.0;       // Automatinio valdymo temperatūros slenkstis

// Laiko žymos
unsigned long lastSensorRead = 0;
unsigned long lastPublish = 0;
unsigned long lastReconnectAttempt = 0;

// ============================================================
// WIFI PRISIJUNGIMAS
// ============================================================

void setupWiFi() {
  Serial.print("[WiFi] Jungiamasi prie ");
  Serial.print(ssid);
  WiFi.begin(ssid, password);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("[WiFi] Prisijungta, IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println("[WiFi] Nepavyko prisijungti, tęsiama autonominiu režimu");
  }
}

// ============================================================
// MQTT RYŠYS IR KOMANDŲ APDOROJIMAS
// ============================================================

// Priimtų MQTT komandų apdorojimas
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  // Konvertuojame payload į tekstą
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  String topicStr = String(topic);
  Serial.println("[MQTT] " + topicStr + " -> " + message);

  // Režimo keitimas
  if (topicStr == "server/commands/mode") {
    currentMode = message;
    manualFanOverride = false; // Pakeitus režimą, atstatome rankinį valdymą
    applyMode();
  }
  // Ventiliatoriaus rankinis valdymas
  else if (topicStr == "server/commands/fan") {
    manualFanOverride = true; // Įjungiame rankinį režimą
    fanOn = (message == "on");
    digitalWrite(FAN_PIN, fanOn ? HIGH : LOW);
  }
  // LED valdymas (formatas: "spalva,ryškumas")
  else if (topicStr == "server/commands/led") {
    int comma = message.indexOf(',');
    if (comma > 0) {
      ledColor = message.substring(0, comma);
      ledBrightness = message.substring(comma + 1).toInt();
    }
    applyLed();
  }
  // Servo valdymas
  else if (topicStr == "server/commands/servo") {
    servoLocked = (message == "lock");
    myServo.attach(SERVO_PIN);
    myServo.write(servoLocked ? 0 : 90);
    delay(500); // Palaukiame kol servo pasiekia poziciją
    myServo.detach(); // Atjungiame signalą – servo nebeburzgia
  }
  // Buzerio signalas
  else if (topicStr == "server/commands/buzzer") {
    if (message == "beep") {
      myServo.detach();
      buzzerBeep();
    }
  }
  // Ventiliatoriaus slenksčio atnaujinimas
  else if (topicStr == "server/commands/threshold") {
    fanThreshold = message.toFloat();
    Serial.print("[Ventiliatorius] Slenkstis atnaujintas: ");
    Serial.println(fanThreshold);
  }
}

// Buzerio pyptelėjimas (rankinis PWM kad nekonfliktuotų su servo)
void buzzerBeep() {
  for (int i = 0; i < 500; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delayMicroseconds(200); // ~2500Hz tonas
    digitalWrite(BUZZER_PIN, LOW);
    delayMicroseconds(200);
  }
}

// Prisijungimas prie MQTT brokerio
void connectMQTT() {
  if (millis() - lastReconnectAttempt < RECONNECT_INTERVAL) return;
  lastReconnectAttempt = millis();

  Serial.print("[MQTT] Jungiamasi...");
  if (mqtt.connect("ESP32Client")) {
    Serial.println("prisijungta");
    // Prenumeruojame visas serverio komandų temas
    mqtt.subscribe("server/commands/#");
  } else {
    Serial.println("nepavyko");
  }
}

// ============================================================
// JUTIKLIŲ NUSKAITYMAS
// ============================================================

void readSensors() {
  float t = sht31.readTemperature();
  float h = sht31.readHumidity();
  float l = lightMeter.readLightLevel();

  // Tikriname ar duomenys validūs
  if (!isnan(t)) temperature = t;
  if (!isnan(h)) humidity = h;
  if (l >= 0) light = l;
}

// ============================================================
// AKTUATORIŲ VALDYMAS
// ============================================================

// Pritaikyti LED spalvą ir ryškumą
void applyLed() {
  CRGB color = CRGB::Blue;
  if (ledColor == "red") color = CRGB::Red;
  else if (ledColor == "green") color = CRGB::Green;
  else if (ledColor == "blue") color = CRGB::Blue;
  else if (ledColor == "white") color = CRGB::White;
  else if (ledColor == "yellow") color = CRGB::Yellow;
  else if (ledColor.startsWith("#") && ledColor.length() == 7) {
    // Pasirinktinė spalva HEX formatu (#RRGGBB)
    long hex = strtol(ledColor.substring(1).c_str(), NULL, 16);
    color = CRGB((hex >> 16) & 0xFF, (hex >> 8) & 0xFF, hex & 0xFF);
  }

  FastLED.setBrightness(ledBrightness);
  fill_solid(leds, NUM_LEDS, color);
  FastLED.show();
}

// Pritaikyti režimo nustatymus
void applyMode() {
  if (currentMode == "focus") {
    ledColor = "blue";
    ledBrightness = 30;
  } else if (currentMode == "break") {
    ledColor = "green";
    ledBrightness = 20;
  }
  applyLed();
}

// Automatinis ventiliatoriaus valdymas pagal temperatūrą
// Veikia TIK kai nėra rankinio valdymo (manualFanOverride == false)
void checkFanAuto() {
  if (manualFanOverride) return; // Rankinis valdymas aktyvus – nekeičiame

  if (temperature >= fanThreshold && !fanOn) {
    fanOn = true;
    digitalWrite(FAN_PIN, HIGH);
    Serial.println("[Ventiliatorius] Įjungtas automatiškai (temp >= slenkstis)");
  } else if (temperature < fanThreshold && fanOn) {
    fanOn = false;
    digitalWrite(FAN_PIN, LOW);
    Serial.println("[Ventiliatorius] Išjungtas automatiškai (temp < slenkstis)");
  }
}

// ============================================================
// DUOMENŲ PUBLIKAVIMAS
// ============================================================

void publishData() {
  if (!mqtt.connected()) return;

  String payload = "{";
  payload += "\"temperature\":" + String(temperature, 1) + ",";
  payload += "\"humidity\":" + String(humidity, 1) + ",";
  payload += "\"light\":" + String(light, 1) + ",";
  payload += "\"mode\":\"" + currentMode + "\",";
  payload += "\"fanOn\":" + String(fanOn ? "true" : "false") + ",";
  payload += "\"ledColor\":\"" + ledColor + "\",";
  payload += "\"ledBrightness\":" + String(ledBrightness) + ",";
  payload += "\"servoLocked\":" + String(servoLocked ? "true" : "false");
  payload += "}";

  mqtt.publish("esp32/data", payload.c_str());
  Serial.println("[Publikuota] " + payload);
}

// ============================================================
// SETUP – Vienkartinė inicializacija
// ============================================================

void setup() {
  Serial.begin(115200);
  Serial.println("\n[Sistema] Paleidžiama...");

  // I2C magistralė jutikliams
  Wire.begin(21, 22);

  // Jutiklių inicializacija
  if (sht31.begin(0x44)) {
    Serial.println("[SHT31] Inicializuotas");
  } else {
    Serial.println("[SHT31] KLAIDA - nerastas!");
  }

  if (lightMeter.begin()) {
    Serial.println("[BH1750] Inicializuotas");
  } else {
    Serial.println("[BH1750] KLAIDA - nerastas!");
  }

  // Aktuatorių inicializacija
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(FAN_PIN, OUTPUT);
  digitalWrite(FAN_PIN, LOW);

  FastLED.addLeds<WS2811, LED_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(BRIGHTNESS);
  fill_solid(leds, NUM_LEDS, CRGB::Blue);
  FastLED.show();
  Serial.println("[LED] Inicializuota");

  myServo.attach(SERVO_PIN);
  myServo.write(0); // Pradinė pozicija – užrakinta
  delay(500);
  myServo.detach(); // Atjungiame kad neburzgtų
  Serial.println("[Servo] Inicializuotas");

  // Paleidimo garso signalas
  buzzerBeep();

  // Tinklo ryšys
  setupWiFi();
  mqtt.setServer(mqttServer, mqttPort);
  mqtt.setCallback(mqttCallback);

  Serial.println("[Sistema] Paruošta");
}

// ============================================================
// LOOP – Pagrindinis ciklas
// ============================================================

void loop() {
  // MQTT ryšio palaikymas
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqtt.connected()) {
      connectMQTT();
    }
    mqtt.loop();
  }

  unsigned long now = millis();

  // Jutiklių nuskaitymas
  if (now - lastSensorRead >= SENSOR_INTERVAL) {
    lastSensorRead = now;
    readSensors();
    checkFanAuto();
  }

  // Duomenų publikavimas
  if (now - lastPublish >= PUBLISH_INTERVAL) {
    lastPublish = now;
    publishData();
  }
}
