package com.opengui.app;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        WebView.setWebContentsDebuggingEnabled(true);
        allowAssistLaunchFromKeyguard(getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        allowAssistLaunchFromKeyguard(intent);
        super.onNewIntent(intent);
    }

    private void allowAssistLaunchFromKeyguard(Intent intent) {
        if (intent != null && Intent.ACTION_ASSIST.equals(intent.getAction())) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
    }
}
