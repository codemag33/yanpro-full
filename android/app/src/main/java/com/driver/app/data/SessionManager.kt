package com.driver.app.data

import android.content.Context

/**
 * Хранит JWT-токен и данные текущего пользователя.
 *
 * ВНИМАНИЕ: обычные SharedPreferences читаются в открытом виде при рут-доступе
 * к устройству. Для продакшена рекомендуется заменить на
 * androidx.security:security-crypto (EncryptedSharedPreferences) — это отдельная
 * gradle-зависимость, сознательно не добавлена здесь, чтобы не тянуть новую
 * библиотеку без вашего решения.
 */
class SessionManager(context: Context) {
    private val prefs = context.getSharedPreferences("yanpro_session", Context.MODE_PRIVATE)

    companion object {
        private const val KEY_TOKEN = "token"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_LOGIN = "login"
        private const val KEY_NAME = "name"
        private const val KEY_ROLE = "role"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_SOUND_ENABLED = "sound_enabled"
        private const val DEFAULT_SERVER_URL = "https://taxi.fbs3.ru"
    }

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

    var userId: String?
        get() = prefs.getString(KEY_USER_ID, null)
        set(value) = prefs.edit().putString(KEY_USER_ID, value).apply()

    var login: String?
        get() = prefs.getString(KEY_LOGIN, null)
        set(value) = prefs.edit().putString(KEY_LOGIN, value).apply()

    var name: String
        get() = prefs.getString(KEY_NAME, "Водитель") ?: "Водитель"
        set(value) = prefs.edit().putString(KEY_NAME, value).apply()

    var role: String
        get() = prefs.getString(KEY_ROLE, "driver") ?: "driver"
        set(value) = prefs.edit().putString(KEY_ROLE, value).apply()

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value).apply()

    val isLoggedIn: Boolean get() = !token.isNullOrEmpty()

    /** Звук/вибрация при новом заказе (вкл/выкл в настройках). */
    var soundEnabled: Boolean
        get() = prefs.getBoolean(KEY_SOUND_ENABLED, true)
        set(value) = prefs.edit().putBoolean(KEY_SOUND_ENABLED, value).apply()

    fun saveAuthResult(result: AuthApi.AuthResult) {
        token = result.token
        userId = result.userId
        login = result.login
        name = result.name
        role = result.role
    }

    fun clear() {
        prefs.edit().clear().apply()
    }
}
