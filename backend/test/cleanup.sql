-- Очистка тестовых пользователей и их данных после e2e-прогонов.
-- Запуск: ssh <server> 'docker compose -f .github/docker/docker-compose.yml \
--   exec -T postgres psql -U yanpro -d yanpro -f -' < backend/test/cleanup.sql
-- Внимание: regexp удаляет ТОЛЬКО тестовые логины (t[pdms]_/tskip/test_/tchat_/tsec_).

DELETE FROM skipped_requests WHERE user_id IN (SELECT id FROM users WHERE login ~ '^(t[psd]_|tskip|test_|tchat_|tsec_)');
DELETE FROM chat_messages WHERE sender_id IN (SELECT id FROM users WHERE login ~ '^(t[psd]_|tskip|test_|tchat_|tsec_)');
DELETE FROM bonus_claims WHERE user_id IN (SELECT id FROM users WHERE login ~ '^(t[psd]_|tskip|test_|tchat_|tsec_)');
DELETE FROM rides WHERE passenger_id IN (SELECT id FROM users WHERE login ~ '^(t[psd]_|tskip|test_|tchat_|tsec_)') OR driver_id IN (SELECT id FROM users WHERE login ~ '^(t[psd]_|tskip|test_|tchat_|tsec_)');
DELETE FROM assistance_requests WHERE passenger_id IN (SELECT id FROM users WHERE login ~ '^(t[psd]_|tskip|test_|tchat_|tsec_)') OR mechanic_id IN (SELECT id FROM users WHERE login ~ '^(t[psd]_|tskip|test_|tchat_|tsec_)');
DELETE FROM driver_profiles WHERE user_id IN (SELECT id FROM users WHERE login ~ '^(t[psd]_|tskip|test_|tchat_|tsec_)');
DELETE FROM users WHERE login ~ '^(t[psd]_|tskip|test_|tchat_|tsec_)';
