-- Run after payments.sql and deploying the verify-paystack edge function.
-- Prevents clients from inserting fake payment/submission records directly.

DROP POLICY IF EXISTS "Students insert own payments" ON payments;
DROP POLICY IF EXISTS "Students insert own submissions" ON submissions;
