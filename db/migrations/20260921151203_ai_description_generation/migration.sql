-- CreateTable
CREATE TABLE `ai_generation_jobs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `reviewStatus` ENUM('DRAFT', 'APPROVED', 'REJECTED', 'APPLIED') NULL,
    `draftHtml` TEXT NULL,
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `previousJobId` INTEGER NULL,
    `provider` VARCHAR(50) NOT NULL,
    `model` VARCHAR(100) NOT NULL,
    `promptVersion` VARCHAR(20) NOT NULL,
    `inputHash` CHAR(64) NOT NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `reviewedAt` DATETIME(3) NULL,

    INDEX `ai_generation_jobs_shopId_status_idx`(`shopId`, `status`),
    INDEX `ai_generation_jobs_shopId_createdAt_idx`(`shopId`, `createdAt`),
    INDEX `ai_generation_jobs_productId_createdAt_idx`(`productId`, `createdAt`),
    UNIQUE INDEX `ai_generation_jobs_shopId_idempotencyKey_key`(`shopId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_generation_inputs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `selectedMediaIds` JSON NOT NULL,
    `productSnapshotJson` JSON NOT NULL,
    `merchantContext` TEXT NULL,
    `imageCount` INTEGER NOT NULL,

    UNIQUE INDEX `ai_generation_inputs_jobId_key`(`jobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_generation_outputs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobId` INTEGER NOT NULL,
    `rawJson` JSON NOT NULL,
    `validatedJson` JSON NOT NULL,
    `warningsJson` JSON NOT NULL,
    `promptTokens` INTEGER NULL,
    `completionTokens` INTEGER NULL,
    `cost` DECIMAL(10, 6) NULL,
    `generationId` VARCHAR(100) NULL,
    `latencyMs` INTEGER NOT NULL,

    UNIQUE INDEX `ai_generation_outputs_jobId_key`(`jobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_description_versions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `jobId` INTEGER NULL,
    `source` ENUM('AI', 'RESTORE') NOT NULL,
    `descriptionHtml` TEXT NOT NULL,
    `previousDescriptionHtml` TEXT NULL,
    `shopifyUpdatedAt` DATETIME(3) NOT NULL,
    `appliedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `appliedBy` VARCHAR(255) NOT NULL,
    `restoredFromId` INTEGER NULL,

    INDEX `product_description_versions_shopId_productId_appliedAt_idx`(`shopId`, `productId`, `appliedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `publication_actions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shopId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `publicationGid` VARCHAR(100) NOT NULL,
    `action` VARCHAR(20) NOT NULL,
    `status` ENUM('REQUESTED', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'REQUESTED',
    `userErrorsJson` JSON NULL,
    `requestedBy` VARCHAR(255) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `publication_actions_shopId_productId_requestedAt_idx`(`shopId`, `productId`, `requestedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ai_generation_jobs` ADD CONSTRAINT `ai_generation_jobs_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `shops`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_generation_jobs` ADD CONSTRAINT `ai_generation_jobs_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_generation_jobs` ADD CONSTRAINT `ai_generation_jobs_previousJobId_fkey` FOREIGN KEY (`previousJobId`) REFERENCES `ai_generation_jobs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_generation_inputs` ADD CONSTRAINT `ai_generation_inputs_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `ai_generation_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_generation_outputs` ADD CONSTRAINT `ai_generation_outputs_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `ai_generation_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_description_versions` ADD CONSTRAINT `product_description_versions_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `shops`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_description_versions` ADD CONSTRAINT `product_description_versions_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_description_versions` ADD CONSTRAINT `product_description_versions_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `ai_generation_jobs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_description_versions` ADD CONSTRAINT `product_description_versions_restoredFromId_fkey` FOREIGN KEY (`restoredFromId`) REFERENCES `product_description_versions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_actions` ADD CONSTRAINT `publication_actions_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `shops`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_actions` ADD CONSTRAINT `publication_actions_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
