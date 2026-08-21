package com.dogmy.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BatteryOptimPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
