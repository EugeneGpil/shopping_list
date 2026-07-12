FROM php:8.4-fpm-bookworm

ARG USER_ID=1000
ARG GROUP_ID=1000
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    git \
    curl \
    libpng-dev \
    libxml2-dev \
    libzip-dev \
    zip \
    unzip \
    libonig-dev \
    libpq-dev \
    libicu-dev \
    && rm -rf /var/lib/apt/lists/* \
    && docker-php-ext-install \
    pdo \
    pdo_pgsql \
    pgsql \
    bcmath \
    gd \
    xml \
    zip \
    mbstring \
    pcntl \
    intl \
    && groupadd -g ${GROUP_ID} app \
    && useradd -u ${USER_ID} -g ${GROUP_ID} -m app \
    && echo 'HISTFILE=/home/app/.bash_history' >> /home/app/.bashrc \
    && echo 'HISTSIZE=1000' >> /home/app/.bashrc \
    && echo 'HISTFILESIZE=2000' >> /home/app/.bashrc \
    && echo 'PROMPT_COMMAND="history -a"' >> /home/app/.bashrc

COPY --from=composer:2.9.7 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

COPY php.ini /usr/local/etc/php/conf.d/custom.ini

USER app
