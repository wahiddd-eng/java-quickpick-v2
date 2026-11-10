package in.javaquickpick.vendor;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Raw ESC/POS transport for 58/80 mm kitchen printers.
 *
 *  - BLUETOOTH: Bluetooth Classic SPP (RFCOMM) to a printer already paired in Android settings.
 *  - NETWORK:   TCP to host:port (usually 9100) on the shop's Wi-Fi/LAN.
 *
 * The slip bytes are built in TypeScript (packages/shared/src/ticket.ts) and passed in as base64, so this class only
 * moves bytes and reports errors. All I/O runs on one background thread, so slips print in order.
 *
 * STATUS: written against the Capacitor 6 plugin API but NOT yet compiled with the Android SDK or run on a device.
 * Test it with the chosen printer before relying on it (docs/printing.md).
 */
@CapacitorPlugin(
    name = "QuickPickPrinter",
    permissions = {
        @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "bluetooth")
    }
)
public class QuickPickPrinterPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    /** DLE EOT 4: real-time paper sensor status (supported by many, not all, ESC/POS printers). */
    private static final byte[] PAPER_STATUS = new byte[] { 0x10, 0x04, 0x04 };

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    // ---------- JS API ----------

    @PluginMethod
    public void print(PluginCall call) {
        if (needsBluetoothPermission(call)) return;
        final String connection = call.getString("connection", "");
        final String address = call.getString("address", "");
        final String data = call.getString("data", "");
        final int timeoutMs = call.getInt("timeoutMs", 8000);
        io.execute(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                try (Conn c = open(connection, address, timeoutMs)) {
                    c.out.write(bytes);
                    c.out.flush();
                    // Give the printer's buffer time to drain before the socket closes (some printers drop the tail).
                    Thread.sleep(Math.min(1500, 200 + bytes.length / 20));
                }
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                rejectWith(call, e);
            }
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        if (needsBluetoothPermission(call)) return;
        final String connection = call.getString("connection", "");
        final String address = call.getString("address", "");
        final int timeoutMs = call.getInt("timeoutMs", 5000);
        io.execute(() -> {
            JSObject ret = new JSObject();
            try (Conn c = open(connection, address, timeoutMs)) {
                c.out.write(PAPER_STATUS);
                c.out.flush();
                int b = c.readByte(1500);
                if (b >= 0 && (b & 0x60) == 0x60) {
                    ret.put("state", "PAPER_OUT");
                    ret.put("detail", "Paper end detected");
                } else {
                    // No reply means the printer does not support status — the connection itself worked.
                    ret.put("state", "ONLINE");
                    if (b < 0) ret.put("detail", "Connected (printer did not report paper status)");
                }
                call.resolve(ret);
            } catch (Exception e) {
                ret.put("state", "OFFLINE");
                ret.put("detail", e.getMessage());
                call.resolve(ret);
            }
        });
    }

    @PluginMethod
    public void listPaired(PluginCall call) {
        if (needsBluetoothPermission(call)) return;
        try {
            BluetoothAdapter adapter = adapter();
            JSArray devices = new JSArray();
            if (adapter != null) {
                Set<BluetoothDevice> bonded = adapter.getBondedDevices();
                for (BluetoothDevice d : bonded) {
                    JSObject o = new JSObject();
                    o.put("name", d.getName() == null ? "Unknown" : d.getName());
                    o.put("address", d.getAddress());
                    devices.put(o);
                }
            }
            JSObject ret = new JSObject();
            ret.put("devices", devices);
            call.resolve(ret);
        } catch (SecurityException e) {
            call.reject("Bluetooth permission was denied", "PERMISSION");
        }
    }

    @PermissionCallback
    private void bluetoothPermissionResult(PluginCall call) {
        if (getPermissionState("bluetooth") != PermissionState.GRANTED) {
            call.reject("Bluetooth permission is needed to print to a Bluetooth printer", "PERMISSION");
            return;
        }
        switch (call.getMethodName()) {
            case "print": print(call); break;
            case "status": status(call); break;
            default: listPaired(call);
        }
    }

    // ---------- transport ----------

    /** Android 12+ needs BLUETOOTH_CONNECT at runtime; older versions use install-time permissions. */
    private boolean needsBluetoothPermission(PluginCall call) {
        boolean bt = "BLUETOOTH".equals(call.getString("connection", "BLUETOOTH")) || "listPaired".equals(call.getMethodName());
        if (bt && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState("bluetooth") != PermissionState.GRANTED) {
            requestPermissionForAlias("bluetooth", call, "bluetoothPermissionResult");
            return true;
        }
        return false;
    }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    private Conn open(String connection, String address, int timeoutMs) throws IOException {
        if ("NETWORK".equals(connection)) {
            int colon = address.lastIndexOf(':');
            String host = colon > 0 ? address.substring(0, colon) : address;
            int port = colon > 0 ? Integer.parseInt(address.substring(colon + 1)) : 9100;
            Socket s = new Socket();
            s.connect(new InetSocketAddress(host, port), timeoutMs);
            s.setSoTimeout(timeoutMs);
            return new Conn(s);
        }
        if ("BLUETOOTH".equals(connection)) {
            BluetoothAdapter adapter = adapter();
            if (adapter == null) throw new IOException("This tablet has no Bluetooth");
            if (!adapter.isEnabled()) throw new IOException("Bluetooth is off");
            BluetoothDevice device = adapter.getRemoteDevice(address);
            BluetoothSocket s = device.createRfcommSocketToServiceRecord(SPP_UUID);
            adapter.cancelDiscovery();
            s.connect(); // blocks; Android applies its own timeout (~12 s)
            return new Conn(s);
        }
        throw new IOException("Unknown printer connection: " + connection);
    }

    private void rejectWith(PluginCall call, Exception e) {
        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        String code = (e instanceof IOException) ? "OFFLINE" : "ERROR";
        if (e instanceof SecurityException) code = "PERMISSION";
        call.reject(msg, code, e);
    }

    /** One open printer connection (TCP or RFCOMM). */
    private static final class Conn implements AutoCloseable {
        final OutputStream out;
        final InputStream in;
        private final Socket tcp;
        private final BluetoothSocket bt;

        Conn(Socket s) throws IOException {
            this.tcp = s;
            this.bt = null;
            this.out = s.getOutputStream();
            this.in = s.getInputStream();
        }

        Conn(BluetoothSocket s) throws IOException {
            this.tcp = null;
            this.bt = s;
            this.out = s.getOutputStream();
            this.in = s.getInputStream();
        }

        /** Read one status byte if the printer answers within the wait, else -1. */
        int readByte(int waitMs) throws IOException, InterruptedException {
            long until = System.currentTimeMillis() + waitMs;
            while (System.currentTimeMillis() < until) {
                if (in.available() > 0) return in.read();
                Thread.sleep(50);
            }
            return -1;
        }

        @Override
        public void close() {
            try { if (tcp != null) tcp.close(); } catch (IOException ignored) { }
            try { if (bt != null) bt.close(); } catch (IOException ignored) { }
        }
    }
}
