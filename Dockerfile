FROM ubuntu:latest
COPY . .
RUN apt-get update && apt-get install h2o nodejs npm -y && npm install -g nve
RUN ls
# RUN (h2o -c h2o.conf &) && nve 15 node benchmark.js && pkill h2o
