package com.driver.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * REST-клиент для /api/auth/* нового бэкенда.
 * Пароль никогда не сравнивается на клиенте — только пересылается по HTTPS на сервер,
 * который хеширует и проверяет его сам (см. src/routes/auth.js).
 */
class AuthApi(private val serverUrl: String) {

    data class AuthResult(
        val token: String,
        val userId: String,
        val login: String,
        val name: String,
        val role: String
    )

    sealed class AuthError : Exception() {
        object InvalidCredentials : AuthError()
        object LoginTaken : AuthError()
        object Network : AuthError()
        data class Other(val code: String) : AuthError()
    }

    suspend fun login(login: String, password: String): AuthResult = withContext(Dispatchers.IO) {
        val body = JSONObject().put("login", login).put("password", password)
        val json = post("/api/auth/login", body)
        parseAuthResult(json)
    }

    suspend fun register(
        login: String,
        password: String,
        name: String,
        role: String,
        phone: String? = null,
        vehicleMake: String? = null,
        vehiclePlate: String? = null
    ): AuthResult = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("login", login)
            .put("password", password)
            .put("name", name)
            .put("role", role)
        phone?.let { body.put("phone", it) }
        vehicleMake?.let { body.put("vehicle_make", it) }
        vehiclePlate?.let { body.put("vehicle_plate", it) }
        val json = post("/api/auth/register", body)
        parseAuthResult(json)
    }

    private fun parseAuthResult(json: JSONObject): AuthResult {
        val user = json.getJSONObject("user")
        return AuthResult(
            token = json.getString("token"),
            userId = user.getString("id"),
            login = user.getString("login"),
            name = user.getString("name"),
            role = user.getString("role")
        )
    }

    private fun post(path: String, body: JSONObject): JSONObject {
        val connection = (URL(serverUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 10_000
            readTimeout = 10_000
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
            val json = JSONObject(text)
            if (code !in 200..299) {
                throw when (json.optString("error")) {
                    "invalid_credentials" -> AuthError.InvalidCredentials
                    "login_taken" -> AuthError.LoginTaken
                    else -> AuthError.Other(json.optString("error", "unknown"))
                }
            }
            return json
        } catch (e: AuthError) {
            throw e
        } catch (e: Exception) {
            throw AuthError.Network
        } finally {
            connection.disconnect()
        }
    }
}
