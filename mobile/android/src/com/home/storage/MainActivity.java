package com.home.storage;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Arrays;

import javax.net.ssl.SSLException;

// NFC：碰一下贴了标签的收纳位置就能定位。只用标签 UID 作标识，不往标签里写数据。
import android.app.PendingIntent;
import android.content.IntentFilter;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.Ndef;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;

/**
 * 家庭收纳 · 安卓端外壳
 * ===========================================================================
 * 这个类只做四件事，业务逻辑一行都不在这里：
 *   1. 起一个 WebView，把 assets/www 里的界面加载起来；
 *   2. 给页面提供「读文件」的能力（页面里的地址是虚拟的 https://hs.local，
 *      真实文件从 assets 里取）；
 *   3. 给页面提供「发网络请求」的能力（局域网 http 直连 NAS，绕开浏览器跨域限制）；
 *   4. 处理摄像头、文件选择、返回键这些浏览器做不了的事。
 *
 * 为什么界面资源要挂在 https://hs.local 而不是 file://
 *   页面里有两处依赖「安全源」：
 *     - 扫码要用 navigator.mediaDevices.getUserMedia，file:// 不是安全源，会被直接拒绝；
 *     - 数据存在 localStorage，而 file:// 属于不透明源，各版本 WebView 行为不一致，
 *       有的直接不落盘——那等于用户存的资料会丢。
 *   挂在一个虚拟的 https 域名上，两个问题一起解决。
 */
public class MainActivity extends Activity {

    private static final String TAG = "HomeStorage";

    /** 页面所在的虚拟域名，只在 WebView 内部有效，不产生任何真实网络请求 */
    private static final String HOST = "hs.local";
    private static final String ORIGIN = "https://" + HOST;
    private static final String START_URL = ORIGIN + "/index.html";

    private static final int REQ_FILE = 1001;
    private static final int REQ_PERM = 1002;

    private WebView webView;

    /** 页面发起的文件选择请求，选完要回调给它 */
    private ValueCallback<Uri[]> fileCallback;

    /** 页面请求摄像头权限时挂起，等系统权限对话框的结果 */
    private PermissionRequest pendingWebPermission;

    /** 连按两次返回键退出的时间戳 */
    private long lastBackAt = 0;

    // ===================== NFC =====================
    // 碰一下贴了标签的收纳位置，就把标签 UID 送回页面，由页面去查是哪个位置。
    private NfcAdapter nfcAdapter;
    private PendingIntent nfcPendingIntent;
    private IntentFilter[] nfcFilters;
    private boolean nfcAvailable = false;
    /** 页面还没加载完时扫到的标签先攒着，onPageFinished 后再投递 */
    private String pendingNfcJson = null;
    /** 页面首屏加载完成（onPageFinished 之后 evaluateJavascript 才稳） */
    private boolean pageReady = false;

    // =======================================================================
    // 生命周期
    // =======================================================================

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 整个界面就是 WebView，不需要布局文件
        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webView);
        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        // 数据存在 localStorage，不开这个开关存不进去
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // 手机上不需要缩放，禁掉可以避免误触双指缩放把界面放大
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // 扫码页会自动播放摄像头画面，不设置的话部分机型要求先有用户手势
        s.setMediaPlaybackRequiresUserGesture(false);
        // 禁止用 file:// 读本地文件。资源是通过下面的 shouldInterceptRequest
        // 直接从 assets 读的，不需要开这个口子
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // 允许 http 明文请求：NAS 在局域网里通常就是 http，没有证书
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // 允许用电脑上的 chrome://inspect 调试这个 WebView。
        // 出问题时这是唯一能看控制台的办法，所以默认打开。
        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.addJavascriptInterface(new Bridge(), "HSAndroid");
        webView.setWebViewClient(new AssetClient());
        webView.setWebChromeClient(new PageChromeClient());

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }

        setupNfc();
        // 如果是「碰一下标签」冷启动的，onCreate 拿到的 intent 就是 NFC intent
        handleNfcIntent(getIntent());

        requestStartupPermissions();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /**
     * 首次启动申请必要权限。
     * 摄像头是扫码用的；存储权限只有 Android 9 及以下需要（10 起改用 MediaStore，
     * 不再需要这个权限）。一次性申请完，免得用户扫到一半才被弹窗打断。
     */
    private void requestStartupPermissions() {
        if (Build.VERSION.SDK_INT < 23) return;

        java.util.ArrayList<String> need = new java.util.ArrayList<String>();
        if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            need.add(android.Manifest.permission.CAMERA);
        }
        if (Build.VERSION.SDK_INT < 29
                && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            need.add(android.Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }
        if (!need.isEmpty()) {
            requestPermissions(need.toArray(new String[0]), REQ_PERM);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code != REQ_PERM) return;

        // 用户刚刚对摄像头做了决定，把挂起的页面请求处理掉
        if (pendingWebPermission != null) {
            boolean granted = checkSelfPermission(android.Manifest.permission.CAMERA)
                    == PackageManager.PERMISSION_GRANTED;
            if (granted) {
                pendingWebPermission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                pendingWebPermission.deny();
            }
            pendingWebPermission = null;
        }
    }

    // =======================================================================
    // NFC：碰一下贴了标签的收纳位置就定位
    // =======================================================================

    @Override
    protected void onResume() {
        super.onResume();
        // 应用在前台时，标签事件优先交给我们，体验最顺滑
        if (nfcAdapter != null) {
            try {
                nfcAdapter.enableForegroundDispatch(
                    this, nfcPendingIntent, nfcFilters, new String[nfcFilters.length][0]);
            } catch (Exception e) {
                Log.w(TAG, "启用 NFC 前台调度失败", e);
            }
        }
    }

    @Override
    protected void onPause() {
        if (nfcAdapter != null) {
            try {
                nfcAdapter.disableForegroundDispatch(this);
            } catch (Exception e) { /* 忽略 */ }
        }
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleNfcIntent(intent);
    }

    /**
     * 准备 NFC 前台调度。没有 NFC 硬件的手机这里直接跳过，其余功能不受影响。
     */
    private void setupNfc() {
        try {
            nfcAdapter = NfcAdapter.getDefaultAdapter(this);
        } catch (Exception e) {
            nfcAdapter = null;
        }
        nfcAvailable = nfcAdapter != null;
        if (!nfcAvailable) return;

        nfcPendingIntent = PendingIntent.getActivity(
            this, 0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        // TECH_DISCOVERED 与 TAG_DISCOVERED 都不要求标签带 NDEF 内容，
        // 连「只有 UID 的空白卡」也能碰。
        IntentFilter tech = new IntentFilter(NfcAdapter.ACTION_TECH_DISCOVERED);
        IntentFilter tag = new IntentFilter(NfcAdapter.ACTION_TAG_DISCOVERED);
        nfcFilters = new IntentFilter[] { tech, tag };
    }

    /** 解析标签，把 UID（和可选的 NDEF 文本）打包成 JSON 送回页面 */
    private void handleNfcIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!NfcAdapter.ACTION_TAG_DISCOVERED.equals(action)
                && !NfcAdapter.ACTION_TECH_DISCOVERED.equals(action)
                && !NfcAdapter.ACTION_NDEF_DISCOVERED.equals(action)) {
            return;
        }
        Tag tag = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG);
        if (tag == null) {
            deliverNfc("{}");
            return;
        }
        JSONObject obj = new JSONObject();
        try {
            obj.put("uid", bytesToHex(tag.getId()));
            obj.put("tech", new org.json.JSONArray(Arrays.asList(tag.getTechList())));
            String text = readNdefText(tag);
            if (text != null) obj.put("text", text);
        } catch (Exception e) {
            Log.w(TAG, "解析 NFC 标签失败", e);
        }
        deliverNfc(obj.toString());
    }

    /** 把标签事件交给页面。页面没就绪就先攒着（冷启动场景） */
    private void deliverNfc(String json) {
        if (webView == null) {
            pendingNfcJson = json;
            return;
        }
        if (pageReady) {
            final String js = "window.__hsOnNfc && window.__hsOnNfc(" + JSONObject.quote(json) + ")";
            webView.post(new Runnable() {
                @Override
                public void run() {
                    if (webView != null) webView.evaluateJavascript(js, null);
                }
            });
        } else {
            pendingNfcJson = json;
        }
    }

    /** 标签上若写了文字（NDEF），一起带回；读不到也不影响按 UID 定位 */
    private static String readNdefText(Tag tag) {
        try {
            Ndef ndef = Ndef.get(tag);
            if (ndef == null) return null;
            NdefMessage msg = ndef.getCachedNdefMessage();
            if (msg == null) {
                try { msg = ndef.getNdefMessage(); } catch (Exception e) { msg = null; }
            }
            if (msg == null) return null;
            StringBuilder sb = new StringBuilder();
            for (NdefRecord r : msg.getRecords()) {
                String s = ndefTextRecordToString(r);
                if (s != null) sb.append(s);
            }
            return sb.length() > 0 ? sb.toString() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String ndefTextRecordToString(NdefRecord r) {
        try {
            if (r.getTnf() != NdefRecord.TNF_WELL_KNOWN) return null;
            if (!Arrays.equals(r.getType(), NdefRecord.RTD_TEXT)) return null;
            byte[] payload = r.getPayload();
            if (payload == null || payload.length == 0) return null;
            int status = payload[0] & 0xFF;
            int langLen = status & 0x3F;
            int start = 1 + langLen;
            return new String(payload, start, payload.length - start, "UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    private static String bytesToHex(byte[] bytes) {
        if (bytes == null) return "";
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02X", b));
        return sb.toString();
    }

    // =======================================================================
    // 资源加载：把 https://hs.local/xxx 映射到 assets/www/xxx
    // =======================================================================

    private class AssetClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null || !HOST.equals(uri.getHost())) return null;

            String path = uri.getPath();
            if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";

            String assetPath = "www" + path;
            try {
                InputStream in = getAssets().open(assetPath);
                return new WebResourceResponse(mimeOf(assetPath), "utf-8", in);
            } catch (Exception e) {
                // 缺资源时给一个能看懂的提示，而不是让页面白屏
                String msg = "找不到资源：" + assetPath;
                Log.e(TAG, msg);
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                        new HashMap<String, String>(),
                        new ByteArrayInputStream(msg.getBytes()));
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            // 站内跳转自己处理；站外链接交给系统浏览器
            if (uri != null && HOST.equals(uri.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception e) {
                Toast.makeText(MainActivity.this, "无法打开这个链接", Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        /**
         * 首屏加载完：标记页面就绪，并把冷启动时攒下的 NFC 标签事件补投出去。
         * 否则「碰一下冷启动」会丢事件——onCreate 里的 handleNfcIntent 当时页面还没好。
         */
        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
            if (pendingNfcJson != null && webView != null) {
                final String js = "window.__hsOnNfc && window.__hsOnNfc("
                    + JSONObject.quote(pendingNfcJson) + ")";
                final String p = pendingNfcJson;
                pendingNfcJson = null;
                webView.post(new Runnable() {
                    @Override
                    public void run() {
                        if (webView != null) webView.evaluateJavascript(js, null);
                    }
                });
            }
            super.onPageFinished(view, url);
        }
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    // =======================================================================
    // 页面需要的浏览器能力
    // =======================================================================

    private class PageChromeClient extends WebChromeClient {

        /**
         * 摄像头授权：页面的 getUserMedia 会走到这里。
         * 必须先确认系统权限已授予，再 grant 给页面，否则页面拿到的是空流。
         */
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    String[] res = request.getResources();
                    boolean wantsCamera = false;
                    for (int i = 0; i < res.length; i++) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res[i])) wantsCamera = true;
                    }
                    if (!wantsCamera) {
                        request.deny();
                        return;
                    }
                    if (Build.VERSION.SDK_INT < 23
                            || checkSelfPermission(android.Manifest.permission.CAMERA)
                            == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    } else {
                        pendingWebPermission = request;
                        requestPermissions(new String[]{android.Manifest.permission.CAMERA}, REQ_PERM);
                    }
                }
            });
        }

        /**
         * 文件选择：页面里的 <input type="file"> 默认在 WebView 里点了没反应，
         * 必须在这里接住并转成系统选择器。
         * 导入备份、从图片识别条码都依赖它。
         */
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                        FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;

            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            try {
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
            } catch (Exception e) {
                fileCallback = null;
                Toast.makeText(MainActivity.this, "没有找到可用的文件管理器", Toast.LENGTH_SHORT).show();
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            // 把页面日志转到 logcat，出问题时能直接看
            Log.d(TAG, "[页面] " + m.message() + " @" + m.lineNumber());
            return true;
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
        }
    }

    // =======================================================================
    // 返回键：优先关弹窗，其次连按两次退出
    // =======================================================================

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode != KeyEvent.KEYCODE_BACK || webView == null) {
            return super.onKeyDown(keyCode, event);
        }

        // 先问页面有没有要处理的（比如关闭正在编辑的弹窗）。
        // evaluateJavascript 是异步的，所以这里一律先吃掉返回键，
        // 再根据页面的回答决定要不要走退出流程。
        webView.evaluateJavascript(
                "(function(){try{return String(!!(window.__hsOnBack&&window.__hsOnBack()))}catch(e){return 'false'}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if ("\"true\"".equals(value) || "true".equals(value)) return;
                        confirmExit();
                    }
                });
        return true;
    }

    private void confirmExit() {
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            finish();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, "再按一次返回键退出", Toast.LENGTH_SHORT).show();
    }

    // =======================================================================
    // 页面与原生之间的桥
    // =======================================================================

    /**
     * 暴露给页面的原生能力。页面里通过 window.HSAndroid 访问。
     *
     * 注意：这些方法由 WebView 在「JavaBridge 线程」上调用，不在主线程，
     * 所以可以安全地做网络和文件读写；但任何触碰界面的操作都必须 post 回主线程。
     */
    private class Bridge {

        /**
         * 代页面发 HTTP 请求。
         *
         * 为什么不让页面自己发：页面在 https://hs.local 上，NAS 是局域网 http，
         * 直接发会同时踩跨域（CORS 预检）和混合内容（https 页面请求 http）两个坑。
         * 交给原生发，两个限制都不存在，用户也不用给 NAS 配证书或跨域头。
         *
         * 调用后立刻返回，结果通过 window.__HS_HTTP_DONE(id, 结果) 回调。
         */
        @JavascriptInterface
        public void http(final String id, final String method, final String url,
                         final String headersJson, final String body, final int timeoutMs) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    final String result = doRequest(method, url, headersJson, body, timeoutMs);
                    if (webView == null) return;
                    webView.post(new Runnable() {
                        @Override
                        public void run() {
                            if (webView == null) return;
                            String js = "window.__HS_HTTP_DONE(" + JSONObject.quote(id) + "," + result + ")";
                            webView.evaluateJavascript(js, null);
                        }
                    });
                }
            }).start();
        }

        /** 把导出的备份文件写进「下载」目录 */
        @JavascriptInterface
        public String saveFile(String name, String content) {
            try {
                return saveToDownloads(safeName(name), content);
            } catch (Exception e) {
                Log.e(TAG, "导出失败", e);
                return null;
            }
        }

        /** 发一条系统通知（到期提醒用） */
        @JavascriptInterface
        public void notify(String title, String body) {
            try {
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm == null) return;
                String channelId = "home-storage";
                Notification.Builder b;
                if (Build.VERSION.SDK_INT >= 26) {
                    NotificationChannel ch = new NotificationChannel(
                            channelId, "到期提醒", NotificationManager.IMPORTANCE_DEFAULT);
                    nm.createNotificationChannel(ch);
                    b = new Notification.Builder(MainActivity.this, channelId);
                } else {
                    b = new Notification.Builder(MainActivity.this);
                }
                b.setSmallIcon(android.R.drawable.ic_dialog_info)
                        .setContentTitle(title == null ? "家庭收纳" : title)
                        .setContentText(body == null ? "" : body)
                        .setAutoCancel(true);
                nm.notify((int) (System.currentTimeMillis() & 0x7fffffff), b.build());
            } catch (Exception e) {
                Log.w(TAG, "通知失败", e);
            }
        }

        /** 这台手机有没有 NFC 硬件（页面据此决定要不要显示「碰一碰」相关按钮） */
        @JavascriptInterface
        public boolean nfcSupported() {
            return nfcAvailable;
        }
    }

    // =======================================================================
    // 网络
    // =======================================================================

    private String doRequest(String method, String url, String headersJson, String body, int timeoutMs) {
        HttpURLConnection conn = null;
        try {
            JSONObject out = new JSONObject();
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method == null ? "GET" : method);
            int t = timeoutMs > 0 ? timeoutMs : 15000;
            conn.setConnectTimeout(t);
            conn.setReadTimeout(t);
            conn.setInstanceFollowRedirects(true);

            JSONObject headers = new JSONObject(headersJson == null || headersJson.length() == 0
                    ? "{}" : headersJson);
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                // 这两个头交给 HttpURLConnection 自己算，手工设置会和服务端对不上
                if ("content-length".equalsIgnoreCase(k)) continue;
                if ("host".equalsIgnoreCase(k)) continue;
                conn.setRequestProperty(k, headers.getString(k));
            }

            if (body != null && body.length() > 0) {
                conn.setDoOutput(true);
                byte[] bytes = body.getBytes("UTF-8");
                conn.setFixedLengthStreamingMode(bytes.length);
                OutputStream os = conn.getOutputStream();
                os.write(bytes);
                os.flush();
                os.close();
            }

            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readAll(in);

            out.put("ok", true);
            out.put("status", status);
            out.put("body", text);
            return out.toString();
        } catch (Exception e) {
            try {
                JSONObject out = new JSONObject();
                out.put("ok", false);
                out.put("error", describeNetworkError(e));
                return out.toString();
            } catch (Exception inner) {
                return "{\"ok\":false,\"error\":\"网络请求失败\"}";
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * 把 Java 的异常翻译成页面认得的错误码。
     * 页面那边（适配层）会根据这些码给出「找不到主机」「服务没启动」这类具体提示，
     * 否则用户只能看到一句没用的英文异常。
     */
    private static String describeNetworkError(Exception e) {
        if (e instanceof UnknownHostException) return "ENOTFOUND";
        if (e instanceof SocketTimeoutException) return "ETIMEDOUT";
        if (e instanceof ConnectException) return "ECONNREFUSED";
        if (e instanceof SSLException) return "CERT";
        String m = e.getMessage();
        return m == null || m.length() == 0 ? e.getClass().getSimpleName() : m;
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), "UTF-8");
    }

    // =======================================================================
    // 文件
    // =======================================================================

    /** 去掉文件名里的路径分隔符，避免被构造出越界路径 */
    private static String safeName(String name) {
        String n = name == null ? "home-storage-backup.json" : name;
        n = n.replace('/', '_').replace('\\', '_').replace("..", "_");
        if (n.length() == 0) n = "home-storage-backup.json";
        return n;
    }

    /**
     * 写入系统「下载」目录。
     * Android 10 起不允许直接写公共目录，改用 MediaStore 登记后再写入；
     * Android 9 及以下走老路子（需要存储权限）。
     * 两条路都指向同一个用户能找到的位置——「文件管理 → 下载」。
     */
    private String saveToDownloads(String name, String content) throws Exception {
        byte[] bytes = content == null ? new byte[0] : content.getBytes("UTF-8");

        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
            cv.put(MediaStore.Downloads.MIME_TYPE, name.endsWith(".csv")
                    ? "text/csv" : "application/json");
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri == null) throw new Exception("无法在下载目录创建文件");
            OutputStream os = getContentResolver().openOutputStream(uri);
            os.write(bytes);
            os.flush();
            os.close();
            return "下载/" + name;
        }

        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir != null && !dir.exists()) dir.mkdirs();
        File f = new File(dir, name);
        FileOutputStream fos = new FileOutputStream(f);
        fos.write(bytes);
        fos.flush();
        fos.close();
        return f.getAbsolutePath();
    }
}
