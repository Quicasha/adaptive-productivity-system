# Setup guide

Everything needed to run the system end to end, from an empty machine. Two halves: the server on a
computer, and the firmware on an ESP32. The server works on its own, so start there and add the
hardware once it is up.

---

## Part 1 - the server

### 1. Node.js

Node 18 or newer.

```bash
node --version
```

If that fails, install from [nodejs.org](https://nodejs.org).

### 2. Get the code and its dependencies

```bash
git clone https://github.com/Quicasha/adaptive-productivity-system.git
cd adaptive-productivity-system
npm install
```

`npm install` reads `package.json` and downloads Express, the MQTT client, `ws` and
`better-sqlite3` into `node_modules/`. That folder is not in the repository on purpose - it is
large, machine-specific, and fully reproducible from `package-lock.json`, which is committed so
everyone installs the exact same versions.

### 3. An MQTT broker

The server and the ESP32 do not talk to each other directly. Both connect to a broker, which is
what makes the hardware side replaceable without touching the server.

**Windows** - download Mosquitto from [mosquitto.org/download](https://mosquitto.org/download/),
install it, and it runs as a service on port 1883.

**macOS**

```bash
brew install mosquitto && brew services start mosquitto
```

**Linux**

```bash
sudo apt install mosquitto mosquitto-clients && sudo systemctl enable --now mosquitto
```

Check it is listening:

```bash
mosquitto_sub -h localhost -t test
```

It should sit there waiting rather than erroring out. Ctrl+C to stop.

### 4. Run it

```bash
node index.js
```

You should see the server report its address and every module report as initialised. Open
`http://localhost:3000`.

On first run SQLite creates `productivity.db` in the project folder, with the tables and the default
Focus and Break modes already in it. That file is gitignored - it is your data, not part of the
project.

**The dashboard works with no hardware connected.** The ESP32 indicator stays offline and sensor
values stay empty, but modes, the timer, check-ins, notes and the event log all run. That is the
fastest way to see what the system does.

---

## Part 2 - the firmware

### 1. Arduino IDE and ESP32 board support

Install the [Arduino IDE](https://www.arduino.cc/en/software), then add ESP32 support:

**File -> Preferences -> Additional boards manager URLs**, paste:

```
https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
```

Then **Tools -> Board -> Boards Manager**, search `esp32`, install the Espressif package.

### 2. Libraries

**Tools -> Manage Libraries**, install:

| Library | Used for |
|---|---|
| `PubSubClient` | MQTT |
| `BH1750` | Light sensor |
| `Adafruit SHT31 Library` | Temperature and humidity |
| `FastLED` | WS2812B LED |
| `ESP32Servo` | Box latch servo |

### 3. Your own credentials

```bash
cp firmware/secrets.example.h firmware/secrets.h
```

Open `secrets.h` and fill in three values: your WiFi name, its password, and the IP address of the
computer running the server.

Find that IP with `ipconfig` on Windows, or `ifconfig` / `ip addr` on macOS and Linux. It is the
address on your local network, usually starting `192.168.` or `10.` - not `127.0.0.1`, because the
ESP32 has to reach another machine.

`secrets.h` is in `.gitignore`. It will not be committed, which is the whole reason it exists as a
separate file.

### 4. Wiring

| Part | Pin |
|---|---|
| SHT31 and BH1750 | I2C - SDA 21, SCL 22, both 3V3 |
| WS2812B LED | GPIO 18 |
| Buzzer (KY-012) | GPIO 23 |
| Servo (MG90S) | GPIO 5 |
| Fan, through 2N2222 | GPIO 19 |

Both sensors share the I2C bus and have different addresses, so they need no configuration.

The fan is not driven from a GPIO directly - the transistor switches it, because the pin cannot
supply that current. The servo and the fan should have their own 5V supply if you are running
anything more than a small one.

### 5. Flash

Board **ESP32 Dev Module**, pick the port, upload. Open Serial Monitor at **115200** and you will
see the WiFi and MQTT connection attempts.

If WiFi fails, it says so and continues anyway - the fan and LED keep working from the last known
mode. That is intentional, not a fallback that was never tested.

---

## Checking it end to end

1. The server prints that all modules are initialised.
2. `http://localhost:3000` loads and the ESP32 indicator turns green within a few seconds.
3. Temperature, humidity and light show real values and update every three seconds.
4. Switching mode in the dashboard changes the LED colour on the device.
5. Toggling the fan manually turns it on and off.

If the indicator stays offline, the problem is almost always one of three things: the IP in
`secrets.h` is wrong, the broker is not running, or the ESP32 and the computer are on different
networks. Check them in that order.

---

## Common problems

**`better-sqlite3` fails to install.** It compiles native code, so it needs build tools. Windows:
`npm install --global windows-build-tools` in an admin terminal. Linux: `sudo apt install
build-essential python3`.

**Port 3000 already in use.** Change `PORT` in `index.js`.

**MQTT connects, sensors stay empty.** The broker is fine but the ESP32 is not publishing. Check the
Serial Monitor - if the sensors failed to initialise, it is the I2C wiring.

**The servo twitches constantly.** Not enough current. It needs its own 5V supply, sharing ground
with the ESP32.
