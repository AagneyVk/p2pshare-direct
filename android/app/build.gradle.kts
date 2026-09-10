plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.p2pshare.android"
    compileSdk = 35
    ndkVersion = "28.0.13004108"

    defaultConfig {
        applicationId = "com.p2pshare.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
kotlinOptions { jvmTarget = "17" }
    packaging { jniLibs.useLegacyPackaging = true }
}

val buildQuicNative by tasks.registering(Exec::class) {
    val core = rootProject.file("../transport-core")
    inputs.dir(core.resolve("src"))
    inputs.file(core.resolve("Cargo.toml"))
    inputs.file(core.resolve("Cargo.lock"))
    outputs.dir(layout.projectDirectory.dir("src/main/jniLibs"))
    val ndkPath = android.sdkDirectory.resolve("ndk/${android.ndkVersion}").absolutePath
    environment("ANDROID_NDK_HOME", ndkPath)
    environment("ANDROID_NDK_ROOT", ndkPath)
    environment("ANDROID_NDK", ndkPath)
    environment("CARGO_NDK_PLATFORM", "26")
    environment("RUSTFLAGS", "-C link-arg=-Wl,-z,max-page-size=16384")
    workingDir(core)
    commandLine("cargo", "ndk", "-t", "arm64-v8a", "-t", "x86_64",
        "-o", layout.projectDirectory.dir("src/main/jniLibs").asFile.absolutePath,
        "build", "--locked", "--release", "--lib")
}
tasks.named("preBuild") { dependsOn(buildQuicNative) }

dependencies {
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("junit:junit:4.13.2")
    testImplementation("junit:junit:4.13.2")
    implementation("com.github.luben:zstd-jni:1.5.7-6@aar")
}
