#!/bin/sh
# 第一次启动时安装 BS、启用协议插件。数据库在 tmpfs 里，down 之后再 up 就是一个全新的实例。
set -eu

if [ ! -f storage/install.lock ]; then
  php artisan bs:install "$BS_ADMIN_EMAIL" "$BS_ADMIN_PASSWORD" "$BS_ADMIN_NICKNAME"
  # yggdrasil-api 和 yggdrasil-connect 互相冲突，只能启用一个
  for plugin in "$BS_YGGDRASIL_PLUGIN" usm-api legacy-api; do
    php artisan plugin:enable "$plugin"
  done
  # 上面的命令以 root 运行，生成的密钥、日志、缓存要交给 php-fpm 的 www-data
  chown -R www-data:www-data /app
fi

# 健康检查看这个文件：安装和启用插件都完成后才算就绪
touch /tmp/bs-ready
exec docker-php-entrypoint "$@"
