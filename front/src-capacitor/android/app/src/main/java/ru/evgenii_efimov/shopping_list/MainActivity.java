package ru.evgenii_efimov.shopping_list;

import android.os.Bundle;
import android.util.Log;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.BridgeActivity;

/**
 * The WebView shell (`docs/go_webview.md` §9). One behaviour beyond the Capacitor template,
 * and the whole reason this file is not empty: WebAuthn.
 *
 * **A WebView exposes no `PublicKeyCredential` until the app asks for it.** That default is
 * what an earlier on-device probe measured, and it is what every "passkeys don't work in
 * WebViews" answer online is describing. `WEB_AUTHENTICATION_SUPPORT_FOR_APP` routes the
 * page's WebAuthn calls through Play services Credential Manager — the same path a fully
 * native app takes — which reaches the passkeys in Google Password Manager, and therefore the
 * PRF output every encrypted list's data key is wrapped under (`front/src/utils/passkey.js`).
 * Without this call the app runs, the lists load, and every locked list is unopenable.
 *
 * Two things this cannot fix, so it reports rather than hides them:
 *
 *   - `isFeatureSupported` is a check on the **WebView APK installed on the device**, not on
 *     the Android version. An old system WebView answers false and there is nothing to be done
 *     about it from here.
 *   - Whether the `prf` extension survives the trip through Credential Manager is undocumented
 *     and is the open question this build exists to answer. Watch the JS side in
 *     chrome://inspect: a `PrfUnsupportedError` out of `assertPrf` means the extension was
 *     dropped, while the support level logged below says the opt-in itself took effect.
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "ShoppingList";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The bridge, and therefore the WebView whose settings are changed below, is created
        // here — nothing before this line can reach it.
        super.onCreate(savedInstanceState);

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            Log.w(TAG, "This WebView has no WebAuthn support: locked lists cannot be unlocked. "
                + "Needs a current Android System WebView.");
            return;
        }

        WebSettingsCompat.setWebAuthenticationSupport(
            getBridge().getWebView().getSettings(),
            WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
        );

        // Read back rather than assumed: 0 is NONE, 1 is FOR_APP. A silent no-op here and a
        // dropped `prf` extension look identical from the page, and they are fixed in
        // completely different places.
        Log.i(TAG, "WebAuthn support level: " + WebSettingsCompat.getWebAuthenticationSupport(
            getBridge().getWebView().getSettings()));
    }
}
