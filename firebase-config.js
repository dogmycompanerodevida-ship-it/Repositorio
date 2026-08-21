// ======================================
// FIREBASE CONFIG - DOGMY v9+ (Formato Modular)
// ======================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBcoRGpBFE79wPi2N66wiXzT9JmciRGQ5M",
  authDomain: "dogmy-fd002.firebaseapp.com",
  databaseURL: "https://dogmy-fd002-default-rtdb.firebaseio.com",
  projectId: "dogmy-fd002",
  storageBucket: "dogmy-fd002.firebasestorage.app",
  messagingSenderId: "264978778022",
  appId: "1:264978778022:web:11906c159fb5bd869d3167"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export { db };
