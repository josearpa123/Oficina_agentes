package local.oficina.agentes;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Ventana nativa que muestra la oficina (la web de tu PC). Guarda el enlace del servidor y, si no se puede
 * conectar, vuelve a la pantalla de configuración con el motivo.
 */
public class MainActivity extends Activity {
    private static final String SETUP = "file:///android_asset/setup.html";
    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("oficina", MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0E1F);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);

        web.addJavascriptInterface(new Bridge(), "OficinaApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame() && !isSetup(r.getUrl())) {
                    showSetup("No se pudo conectar con el servidor (" + e.getDescription() + "). Revisa que tu PC esté encendido con npm start y que el teléfono llegue a él.");
                }
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse resp) {
                if (r.isForMainFrame() && !isSetup(r.getUrl()) && (resp.getStatusCode() == 401 || resp.getStatusCode() == 403)) {
                    showSetup("El token del enlace no es válido. Copia de nuevo el enlace completo de npm run phone.");
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String scheme = u.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme) || "file".equals(scheme)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });

        load();
    }

    private boolean isSetup(Uri u) {
        return "file".equals(u.getScheme()) && u.getPath() != null && u.getPath().endsWith("setup.html");
    }

    private void load() {
        String url = prefs.getString("url", "");
        if (url.isEmpty()) web.loadUrl(SETUP);
        else web.loadUrl(url);
    }

    private void showSetup(String error) {
        web.loadUrl(SETUP + (error == null ? "" : "?err=" + Uri.encode(error)));
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        web.pauseTimers();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.resumeTimers();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /** Lo que la página puede pedirle a la app. */
    private class Bridge {
        @JavascriptInterface
        public String current() { return prefs.getString("url", ""); }

        /** Devuelve "" si todo bien, o el mensaje de error para mostrar. */
        @JavascriptInterface
        public String save(String raw) {
            String url = raw == null ? "" : raw.trim();
            if (url.isEmpty()) return "Pega el enlace de tu oficina.";
            if (!url.contains("://")) url = "http://" + url;
            Uri u = Uri.parse(url);
            if (!("http".equals(u.getScheme()) || "https".equals(u.getScheme())) || u.getHost() == null || u.getHost().isEmpty()) {
                return "El enlace no es válido. Debe empezar con http:// o https://";
            }
            final String finalUrl = url;
            prefs.edit().putString("url", finalUrl).apply();
            runOnUiThread(new Runnable() { public void run() { web.loadUrl(finalUrl); } });
            return "";
        }

        @JavascriptInterface
        public void retry() {
            runOnUiThread(new Runnable() { public void run() { load(); } });
        }

        /** Desde la oficina: volver a la pantalla de configuración. */
        @JavascriptInterface
        public void reset() {
            runOnUiThread(new Runnable() { public void run() { showSetup(null); } });
        }
    }
}
