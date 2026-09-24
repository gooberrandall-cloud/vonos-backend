-- Add quotation to SaleStatus for draft/quotation sales migrated from Ultimate POS.
ALTER TYPE "SaleStatus" ADD VALUE IF NOT EXISTS 'quotation';
