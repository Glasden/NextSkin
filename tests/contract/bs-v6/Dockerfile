# 录制协议契约用例用的 BS v6（ADR-0001）。发行包和插件按固定版本下载并校验 sha256，不放进仓库。
# 插件版本取自 bs-community/plugins-dist 的 registry_en.json。

FROM alpine:3.21 AS fetch
RUN apk add --no-cache curl unzip
RUN set -eu; \
    fetch() { curl -fsSL --retry 3 -o "$1" "$2" && echo "$3  $1" | sha256sum -c -; }; \
    fetch bs.zip https://github.com/bs-community/blessing-skin-server/releases/download/6.0.2/blessing-skin-server-6.0.2.zip \
        6090d10cb2d751191ae4f343f366fbc51dad8844aace63789e1b47e838121f2a; \
    mkdir /app && unzip -q bs.zip -d /app; \
    fetch p1.zip https://d2jw1l0ullrzt6.cloudfront.net/yggdrasil-api_5.2.1.zip \
        3be3f8ab3998cdafcacaafd919afa37f9d73e1337fb88f156f275e7896cc61aa; \
    fetch p2.zip https://d2jw1l0ullrzt6.cloudfront.net/usm-api_1.2.3.zip \
        4e8866efdedb1759100d9b356c2b5e19b5d0d425f1fa11a7afa32f2fd7b30757; \
    fetch p3.zip https://d2jw1l0ullrzt6.cloudfront.net/legacy-api_1.1.3.zip \
        f3c851e7f033361925c025155d08b02651dc3699d5de26ad0dc69b6740f66fb3; \
    fetch p4.zip https://bs-plugins.littleservice.cn/yggdrasil-connect_6.2.0.zip \
        977fd49053325a12fe5995aada7bb9c637e70e02e01bddfb9f0c8b478ee57f0b; \
    for p in p1 p2 p3 p4; do unzip -q "$p.zip" -d /app/plugins; done
# 数据库连接写进 .env：php-fpm 默认清空环境变量，只靠容器的 environment 传不进 Web 请求
RUN cd /app && cp .env.example .env && sed -i \
        -e 's|^DB_HOST=.*|DB_HOST=db|' \
        -e 's|^DB_USERNAME=.*|DB_USERNAME=blessingskin|' \
        -e 's|^DB_PASSWORD=.*|DB_PASSWORD=blessingskin|' \
        .env && echo 'APP_URL=http://127.0.0.1:38080' >> .env

# 静态文件由 nginx 直接返回，其余请求转给 app（PHP）
FROM nginx:1.28-alpine AS web
COPY --from=fetch /app/public /app/public
COPY nginx.conf /etc/nginx/conf.d/default.conf

# yggdrasil-connect 要求 PHP ^8.1；BS 6.0.2 基于 Laravel 9
FROM php:8.1-fpm AS app
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends libfreetype6-dev libjpeg62-turbo-dev libpng-dev libzip-dev; \
    rm -rf /var/lib/apt/lists/*; \
    docker-php-ext-configure gd --with-freetype --with-jpeg; \
    docker-php-ext-install -j"$(nproc)" gd zip pdo_mysql; \
    mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY --from=fetch /app /app
COPY entrypoint.sh /usr/local/bin/bs-entrypoint
WORKDIR /app
ENTRYPOINT ["sh", "/usr/local/bin/bs-entrypoint"]
CMD ["php-fpm"]
