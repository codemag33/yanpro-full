package com.driver.app

import android.content.Intent
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.driver.app.data.AuthApi
import com.driver.app.data.SessionManager
import kotlinx.coroutines.launch

/**
 * Экран входа/регистрации.
 *
 * ВАЖНО: пароль здесь больше НЕ сравнивается на устройстве. Логин/пароль
 * пересылаются на сервер (`POST /api/auth/login` или `/register`), сервер
 * хеширует и проверяет их сам и возвращает JWT-токен, который дальше
 * предъявляется при подключении Socket.IO (см. RideSocketManager).
 */
class LoginActivity : AppCompatActivity() {

    private lateinit var session: SessionManager
    private var isRegisterMode = false

    private lateinit var etLogin: EditText
    private lateinit var etPassword: EditText
    private lateinit var etName: EditText
    private lateinit var etPhone: EditText
    private lateinit var etVehicleMake: EditText
    private lateinit var etVehiclePlate: EditText
    private lateinit var spinnerRole: Spinner
    private lateinit var registerFields: LinearLayout
    private lateinit var tvFormTitle: TextView
    private lateinit var tvToggleMode: TextView
    private lateinit var tvServerSettings: TextView
    private lateinit var tvError: TextView
    private lateinit var btnSubmit: Button

    private val roles = listOf("driver" to "Водитель", "mechanic" to "Механик")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        session = SessionManager(this)

        if (session.isLoggedIn) {
            goToMain()
            return
        }

        etLogin = findViewById(R.id.etLogin)
        etPassword = findViewById(R.id.etPassword)
        etName = findViewById(R.id.etName)
        etPhone = findViewById(R.id.etPhone)
        etVehicleMake = findViewById(R.id.etVehicleMake)
        etVehiclePlate = findViewById(R.id.etVehiclePlate)
        spinnerRole = findViewById(R.id.spinnerRole)
        registerFields = findViewById(R.id.registerFields)
        tvFormTitle = findViewById(R.id.tvFormTitle)
        tvToggleMode = findViewById(R.id.tvToggleMode)
        tvServerSettings = findViewById(R.id.tvServerSettings)
        tvError = findViewById(R.id.tvError)
        btnSubmit = findViewById(R.id.btnSubmit)

        spinnerRole.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item, roles.map { it.second }
        )

        tvToggleMode.setOnClickListener {
            isRegisterMode = !isRegisterMode
            applyMode()
        }

        tvServerSettings.setOnClickListener { showServerUrlDialog() }

        btnSubmit.setOnClickListener {
            if (isRegisterMode) doRegister() else doLogin()
        }

        applyMode()
    }

    private fun applyMode() {
        tvError.text = ""
        if (isRegisterMode) {
            tvFormTitle.text = "Регистрация"
            registerFields.visibility = android.view.View.VISIBLE
            btnSubmit.text = "Зарегистрироваться"
            tvToggleMode.text = "Уже есть аккаунт? Войти"
        } else {
            tvFormTitle.text = "Вход в систему"
            registerFields.visibility = android.view.View.GONE
            btnSubmit.text = "Войти"
            tvToggleMode.text = "Нет аккаунта? Зарегистрироваться"
        }
    }

    private fun showServerUrlDialog() {
        val input = EditText(this).apply { setText(session.serverUrl) }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Адрес сервера")
            .setView(input)
            .setPositiveButton("Сохранить") { _, _ ->
                val url = input.text.toString().trim().trimEnd('/')
                if (url.isNotEmpty()) session.serverUrl = url
            }
            .setNegativeButton("Отмена", null)
            .show()
    }

    private fun doLogin() {
        val login = etLogin.text.toString().trim()
        val password = etPassword.text.toString()
        if (login.isEmpty() || password.isEmpty()) {
            tvError.text = "Заполните логин и пароль"
            return
        }
        setLoading(true)
        lifecycleScope.launch {
            try {
                val api = AuthApi(session.serverUrl)
                val result = api.login(login, password)
                session.saveAuthResult(result)
                goToMain()
            } catch (e: AuthApi.AuthError) {
                tvError.text = errorMessage(e)
            } catch (e: Exception) {
                tvError.text = "Не удалось подключиться к серверу"
            } finally {
                setLoading(false)
            }
        }
    }

    private fun doRegister() {
        val login = etLogin.text.toString().trim()
        val password = etPassword.text.toString()
        val name = etName.text.toString().trim()
        val phone = etPhone.text.toString().trim()
        val vehicleMake = etVehicleMake.text.toString().trim()
        val vehiclePlate = etVehiclePlate.text.toString().trim()
        val role = roles[spinnerRole.selectedItemPosition].first

        if (login.isEmpty() || name.isEmpty() || password.length < 6) {
            tvError.text = "Проверьте поля — пароль от 6 символов"
            return
        }
        setLoading(true)
        lifecycleScope.launch {
            try {
                val api = AuthApi(session.serverUrl)
                val result = api.register(
                    login = login, password = password, name = name, role = role,
                    phone = phone.ifEmpty { null },
                    vehicleMake = vehicleMake.ifEmpty { null },
                    vehiclePlate = vehiclePlate.ifEmpty { null }
                )
                session.saveAuthResult(result)
                goToMain()
            } catch (e: AuthApi.AuthError) {
                tvError.text = errorMessage(e)
            } catch (e: Exception) {
                tvError.text = "Не удалось подключиться к серверу"
            } finally {
                setLoading(false)
            }
        }
    }

    private fun errorMessage(e: AuthApi.AuthError): String = when (e) {
        is AuthApi.AuthError.InvalidCredentials -> "Неверный логин или пароль"
        is AuthApi.AuthError.LoginTaken -> "Такой логин уже занят"
        is AuthApi.AuthError.Network -> "Сервер недоступен — проверьте адрес и соединение"
        is AuthApi.AuthError.Other -> "Ошибка: ${e.code}"
    }

    private fun setLoading(loading: Boolean) {
        btnSubmit.isEnabled = !loading
        tvToggleMode.isEnabled = !loading
        if (loading) tvError.text = ""
    }

    private fun goToMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
