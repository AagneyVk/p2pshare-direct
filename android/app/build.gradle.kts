plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.p2pshare.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.p2pshare.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.github.luben:zstd-jni:1.5.7-16@aar")
}
