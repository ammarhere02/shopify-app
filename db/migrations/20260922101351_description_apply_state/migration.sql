-- AlterTable
ALTER TABLE `ai_generation_jobs` MODIFY `reviewStatus` ENUM('DRAFT', 'APPROVED', 'REJECTED', 'APPLYING', 'APPLIED') NULL;
