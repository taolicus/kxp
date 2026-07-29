VPS_HOST = tao
TARGET_DIR = /var/www/kxp

deploy:
	@echo "Building Go binary for Linux..."
	GOOS=linux GOARCH=amd64 go build -o kxp kxp.go
	@echo "Uploading binary to VPS..."
	scp kxp $(VPS_HOST):$(TARGET_DIR)/kxp
	@echo "Restarting service..."
	ssh $(VPS_HOST) "systemctl restart kxp"
	@echo "Deployment complete!"

