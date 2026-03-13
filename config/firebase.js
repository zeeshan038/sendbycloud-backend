import admin from "firebase-admin";


const serviceAccount = {
  project_id: process.env.FIREBASE_PROJECT_ID,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
};


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});


console.log("🔥 Firebase Admin Initialized");

export const auth = admin.auth();
export const storage = admin.storage();

export default admin;
