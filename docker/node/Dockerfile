FROM node:24.15.0-bookworm

ARG USER_ID=1000
ARG GROUP_ID=1000

RUN userdel node \
    && groupadd -g ${GROUP_ID} app \
    && useradd -u ${USER_ID} -g ${GROUP_ID} -m app \
    && echo 'HISTFILE=/home/app/.bash_history' >> /home/app/.bashrc \
    && echo 'HISTSIZE=1000' >> /home/app/.bashrc \
    && echo 'HISTFILESIZE=2000' >> /home/app/.bashrc \
    && echo 'PROMPT_COMMAND="history -a"' >> /home/app/.bashrc

ENV NPM_CONFIG_PREFIX=/home/app/.npm-global
ENV PATH="/home/app/.npm-global/bin:${PATH}"

WORKDIR /var/www/html

USER app

CMD ["sleep", "infinity"]
